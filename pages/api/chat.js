// pages/api/chat.js

import { createClient } from "@supabase/supabase-js";
import { Mistral } from "@mistralai/mistralai";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// Tente d'extraire un JSON strict {to, subject, body} depuis un texte.
// Accepte soit une string JSON pure, soit un JSON dans un bloc.
function extractMailJson(content) {
  if (!content || typeof content !== "string") return null;

  const trimmed = content.trim();

  // Cas 1 : contenu = JSON pur
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj?.to && obj?.subject && obj?.body) return obj;
    } catch (_) {}
  }

  // Cas 2 : JSON inclus dans du texte (ex: ```json { ... } ```)
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match?.[0]) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj?.to && obj?.subject && obj?.body) return obj;
    } catch (_) {}
  }

  return null;
}

async function postToMake(payload) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("MAKE_WEBHOOK_URL is not set");
  }

  const r = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Make webhook failed: ${r.status} ${text}`);
  }
  return text;
}

export default async function handler(req, res) {
  // Evite les 405 si un preflight OPTIONS arrive
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Auth: Bearer token (comme vous l’aviez défini)
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    if (!token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(
      token
    );
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const user = userData.user;

    // Récupération du payload (on accepte plusieurs formes pour éviter de casser le front)
    const body = req.body || {};
    const agentSlug = body.agentSlug || body.agent || body.agent_slug || "emma";
    const messages = Array.isArray(body.messages)
      ? body.messages
      : body.message
      ? [{ role: "user", content: String(body.message) }]
      : [];

    if (!messages.length) {
      return res.status(400).json({ error: "No messages provided" });
    }

    // Récupère l’agent
    const { data: agentRow, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", agentSlug)
      .maybeSingle();

    if (agentErr || !agentRow) {
      return res.status(404).json({ error: "Agent not found" });
    }

    // Prompt personnalisé client si présent
    const { data: cfg } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", user.id)
      .eq("agent_id", agentRow.id)
      .maybeSingle();

    // System prompt (global + personnalisé)
    // IMPORTANT: vous avez votre “prompt global” dans votre app. Ici on garde un fallback minimal.
    const systemPrompt =
      (cfg?.system_prompt?.trim() ||
        `Tu es ${agentRow.name || agentRow.slug}. Réponds de façon utile.`) +
      `

Règle spéciale:
Quand la tâche consiste à envoyer un email via Make / Outlook, tu dois produire uniquement un JSON strict (aucun texte autour) avec exactement ces clés : to, subject, body.`;

    // Appel Mistral
    const mistralMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ];

    const completion = await mistral.chat.complete({
      model: "mistral-large-latest",
      messages: mistralMessages,
      temperature: 0.2,
    });

    const assistantContent =
      completion?.choices?.[0]?.message?.content?.trim() || "";

    if (!assistantContent) {
      return res.status(502).json({ error: "Empty model response" });
    }

    // Si le modèle sort un JSON email strict => on appelle Make
    const mailJson = extractMailJson(assistantContent);

    if (mailJson) {
      await postToMake(mailJson);

      // On renvoie une réponse “humaine” au front (sinon le front afficherait juste le JSON)
      return res.status(200).json({
        reply: "Email envoyé via Outlook (Make).",
        emailSent: true,
        email: mailJson,
      });
    }

    // Sinon, conversation normale
    return res.status(200).json({ reply: assistantContent });
  } catch (e) {
    // Pour que vous voyiez enfin “pourquoi ça bloque” côté front
    return res.status(500).json({
      error: "Chat API error",
      message: e?.message || String(e),
    });
  }
}
