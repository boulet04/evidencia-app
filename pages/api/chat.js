// pages/api/chat.js

import { Mistral } from "@mistralai/mistralai";
import { createClient } from "@supabase/supabase-js";
import agentPrompts from "../../lib/agentPrompts"; // fallback local (si tu l'as)
                                                   // sinon adapte le chemin

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// Supabase admin (service role) côté serveur
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function extractBearerToken(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1] || null;
}

// IMPORTANT : on exige un JSON strict, pas de texte autour
function tryParseStrictMailJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();

  // doit commencer/finir par { }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // clés attendues : to, subject, body
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const allowedKeys = new Set(["to", "subject", "body"]);
  const keys = Object.keys(obj);

  // exactement ces 3 clés (ni plus ni moins)
  if (keys.length !== 3) return null;
  for (const k of keys) if (!allowedKeys.has(k)) return null;

  if (typeof obj.to !== "string" || typeof obj.subject !== "string" || typeof obj.body !== "string") return null;
  if (!obj.to.trim() || !obj.subject.trim() || !obj.body.trim()) return null;

  return { to: obj.to.trim(), subject: obj.subject.trim(), body: obj.body };
}

async function callMakeWebhook(payload) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("MAKE_WEBHOOK_URL missing");

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Make error ${resp.status}: ${text}`);
  }
  return text;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const token = extractBearerToken(req);
    if (!token) return res.status(401).json({ error: "Missing Bearer token" });

    const {
      conversation_id,
      agent_slug,
      messages = [],
      // optionnel selon ton front : userMessage, etc.
    } = req.body || {};

    // Auth user
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Invalid user" });

    const user = userData.user;

    if (!agent_slug) return res.status(400).json({ error: "agent_slug is required" });

    // Vérifie agent
    const { data: agentRow, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description, avatar_url")
      .eq("slug", agent_slug)
      .single();

    if (agentErr || !agentRow) return res.status(404).json({ error: "Agent not found" });

    // Vérifie assignation user_agents (si ton modèle impose ça)
    const { data: userAgentRow } = await supabaseAdmin
      .from("user_agents")
      .select("id")
      .eq("user_id", user.id)
      .eq("agent_id", agentRow.id)
      .maybeSingle();

    if (!userAgentRow) {
      return res.status(403).json({ error: "Agent not assigned to user" });
    }

    // Récupère prompt personnalisé client_agent_configs si présent
    const { data: cfgRow } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", user.id)
      .eq("agent_id", agentRow.id)
      .maybeSingle();

    const systemPrompt =
      (cfgRow?.system_prompt && String(cfgRow.system_prompt)) ||
      (agentPrompts?.[agent_slug] ? String(agentPrompts[agent_slug]) : "");

    const context = cfgRow?.context || null;

    // Construit messages pour Mistral
    // Format attendu par Mistral: [{role:"system"|"user"|"assistant", content:"..."}]
    const mistralMessages = [];

    if (systemPrompt) {
      mistralMessages.push({ role: "system", content: systemPrompt });
    }
    if (context) {
      mistralMessages.push({
        role: "system",
        content: `Context (json): ${JSON.stringify(context)}`,
      });
    }

    // messages venant du front
    for (const m of messages) {
      if (!m || !m.role || typeof m.content !== "string") continue;
      const role = m.role === "assistant" ? "assistant" : "user";
      mistralMessages.push({ role, content: m.content });
    }

    // Appel Mistral
    const completion = await mistral.chat.complete({
      model: "mistral-large-latest",
      messages: mistralMessages,
      temperature: 0.4,
    });

    const assistantText =
      completion?.choices?.[0]?.message?.content ??
      completion?.choices?.[0]?.message?.content?.[0]?.text ??
      "";

    const assistantContent = typeof assistantText === "string" ? assistantText : String(assistantText || "");

    // 1) Si l’agent renvoie un JSON mail strict -> on appelle Make
    const mailJson = tryParseStrictMailJson(assistantContent);
    if (mailJson) {
      // Appel Make
      await callMakeWebhook(mailJson);

      // On renvoie au front un message "lisible" (pas le JSON brut)
      return res.status(200).json({
        ok: true,
        mode: "mail_sent",
        assistant: {
          role: "assistant",
          content: "Email envoyé via Make.",
        },
      });
    }

    // 2) Sinon: réponse normale
    return res.status(200).json({
      ok: true,
      mode: "chat",
      assistant: {
        role: "assistant",
        content: assistantContent,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  }
}
