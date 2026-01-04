// pages/api/chat.js
import Mistral from "@mistralai/mistralai";
import { createClient } from "@supabase/supabase-js";
import agentPrompts from "../../lib/agentPrompts";

const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode non autorisée." });
    }

    const { message, agentSlug } = req.body || {};
    const slug = (agentSlug || "").toString().trim().toLowerCase();

    if (!slug) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!message || !message.trim()) return res.status(400).json({ error: "Message vide." });

    // 1) Auth user via token Supabase (envoyé par le front)
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Session invalide." });
    }
    const uid = userData.user.id;

    // 2) Agent (source de vérité: table agents)
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (agentErr || !agent) return res.status(404).json({ error: "Agent introuvable." });

    // 3) Config client (prompt personnalisé) via user_id + agent_id
    const { data: cfg } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", uid)
      .eq("agent_id", agent.id)
      .maybeSingle();

    // 4) Prompt final (priorité: config DB > fallback)
    const fallback =
      agentPrompts?.[agent.slug]?.systemPrompt ||
      `Tu es ${agent.name}, ${agent.description}.`;

    let systemPrompt = (cfg?.system_prompt || fallback).toString();

    if (cfg?.context) {
      // contexte optionnel (jsonb) injecté proprement
      systemPrompt += `\n\nContexte client (JSON):\n${JSON.stringify(cfg.context, null, 2)}`;
    }

    // 5) Appel Mistral
    const completion = await mistral.chat.complete({
      model: "mistral-small-latest",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message.trim() },
      ],
      temperature: 0.7,
    });

    const reply =
      completion?.choices?.[0]?.message?.content?.toString().trim() || "Réponse vide.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
