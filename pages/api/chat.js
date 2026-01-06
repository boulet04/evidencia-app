// pages/api/chat.js
import Mistral from "@mistralai/mistralai";
import agentPrompts from "../../lib/agentPrompts";
import { createClient } from "@supabase/supabase-js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function safeStr(v) {
  return (v ?? "").toString();
}

function parseMaybeJson(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  // 0) Env
  const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!MISTRAL_API_KEY) return res.status(500).json({ step: "env", error: "MISTRAL_API_KEY manquant sur Vercel." });
  if (!SUPABASE_URL) return res.status(500).json({ step: "env", error: "NEXT_PUBLIC_SUPABASE_URL manquant sur Vercel." });
  if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ step: "env", error: "SUPABASE_SERVICE_ROLE_KEY manquant sur Vercel." });

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });

  try {
    // 1) Token user
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ step: "auth", error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({
        step: "auth",
        error: "Session invalide. Reconnectez-vous.",
        detail: safeStr(userErr?.message),
      });
    }
    const userId = userData.user.id;

    // 2) Body
    const { message, agentSlug } = req.body || {};
    const slug = safeStr(agentSlug).trim().toLowerCase();
    const userMsg = safeStr(message).trim();
    if (!slug) return res.status(400).json({ step: "body", error: "Aucun agent sélectionné." });
    if (!userMsg) return res.status(400).json({ step: "body", error: "Message vide." });

    // 3) Agent
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (agentErr || !agent) {
      return res.status(404).json({
        step: "agent",
        error: "Agent introuvable.",
        detail: safeStr(agentErr?.message),
      });
    }

    // 4) Assignation
    const { data: assignment, error: assignErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (assignErr) {
      return res.status(500).json({
        step: "assignation",
        error: "Erreur assignation (user_agents).",
        detail: safeStr(assignErr?.message),
      });
    }
    if (!assignment) {
      return res.status(403).json({
        step: "assignation",
        error: "Accès interdit : agent non assigné.",
      });
    }

    // 5) Prompt custom
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    const ctxObj = !cfgErr ? parseMaybeJson(cfg?.context) : null;

    const customPrompt =
      safeStr(cfg?.system_prompt).trim() ||
      safeStr(ctxObj?.prompt).trim() ||
      safeStr(ctxObj?.systemPrompt).trim() ||
      safeStr(ctxObj?.customPrompt).trim() ||
      "";

    const basePrompt =
      safeStr(agentPrompts?.[slug]?.systemPrompt).trim() ||
      `Tu es ${agent.name}${agent.description ? `, ${agent.description}` : ""}.`;

    const finalSystemPrompt = customPrompt
      ? `${basePrompt}\n\nINSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR :\n${customPrompt}`
      : basePrompt;

    // 6) Mistral
    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: [
        { role: "system", content: finalSystemPrompt },
        { role: "user", content: userMsg },
      ],
      temperature: 0.7,
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({
      step: "catch",
      error: "Erreur interne de l’agent.",
      detail: safeStr(err?.message),
    });
  }
}
