// pages/api/chat.js
import Mistral from "@mistralai/mistralai";
import agentPrompts from "../../lib/agentPrompts";
import { createClient } from "@supabase/supabase-js";

const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

// Supabase Admin (service role) -> uniquement côté serveur
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
  }
);

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function safeStr(v) {
  return (v || "").toString();
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode non autorisée." });
    }

    // 1) Auth user via Bearer token (obligatoire pour savoir quel prompt charger)
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Non authentifié (token manquant)." });
    }

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    }
    const userId = userData.user.id;

    // 2) Body
    const { message, agentSlug } = req.body || {};
    const slug = safeStr(agentSlug).trim().toLowerCase();

    if (!slug) {
      return res.status(400).json({ error: "Aucun agent sélectionné." });
    }
    if (!message || safeStr(message).trim().length === 0) {
      return res.status(400).json({ error: "Message vide." });
    }

    // 3) Charger agent (source de vérité = table agents)
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (agentErr || !agent) {
      return res.status(404).json({ error: "Agent introuvable." });
    }

    // 4) Vérifier assignation (si pas assigné => interdit)
    const { data: assignment, error: assignErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (assignErr) {
      return res.status(500).json({ error: "Erreur assignation (user_agents)." });
    }
    if (!assignment) {
      return res.status(403).json({ error: "Accès interdit : agent non assigné." });
    }

    // 5) Charger prompt personnalisé (client_agent_configs.context.prompt)
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("context")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    // On n’échoue pas si pas de config : on retombe sur le base prompt
    const context = (!cfgErr && cfg?.context) ? cfg.context : null;

    // IMPORTANT : on supporte plusieurs clés au cas où ton UI stocke différemment
    const customPrompt =
      safeStr(context?.prompt).trim() ||
      safeStr(context?.systemPrompt).trim() ||
      safeStr(context?.customPrompt).trim() ||
      "";

    // Base prompt (fallback)
    const basePrompt =
      safeStr(agentPrompts?.[slug]?.systemPrompt).trim() ||
      `Tu es ${agent.name}${agent.description ? `, ${agent.description}` : ""}.`;

    // Prompt final réellement envoyé à Mistral
    const finalSystemPrompt = customPrompt
      ? `${basePrompt}\n\nINSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR :\n${customPrompt}`
      : basePrompt;

    // 6) Appel Mistral
    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: [
        { role: "system", content: finalSystemPrompt },
        { role: "user", content: safeStr(message).trim() },
      ],
      temperature: 0.7,
    });

    const reply =
      completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
