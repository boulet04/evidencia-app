// pages/api/chat.js
import Mistral from "@mistralai/mistralai";
import { createClient } from "@supabase/supabase-js";
import agentPrompts from "../../lib/agentPrompts";

// Supabase admin (bypass RLS) - SERVER ONLY
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

function buildSystemPrompt({ basePrompt, customPrompt, context }) {
  const parts = [];

  // Prompt de base (agentPrompts.js)
  if (basePrompt && basePrompt.trim()) parts.push(basePrompt.trim());

  // Prompt personnalisé (console admin)
  if (customPrompt && customPrompt.trim()) {
    parts.push(`PROMPT PERSONNALISÉ (prioritaire) :\n${customPrompt.trim()}`);
  }

  // Contexte (jsonb)
  if (context) {
    // Tu peux stocker ce que tu veux (urls, notes, etc.)
    parts.push(`CONTEXTE (données) :\n${JSON.stringify(context, null, 2)}`);
  }

  return parts.join("\n\n---\n\n").trim();
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode non autorisée." });
    }

    // 1) Auth: on récupère le token Supabase envoyé par le client
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Token manquant." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Token invalide." });
    }
    const userId = userData.user.id;

    // 2) Inputs
    const { message, agentSlug } = req.body || {};
    const cleanMsg = (message || "").trim();
    const cleanSlug = (agentSlug || "").trim().toLowerCase();

    if (!cleanSlug) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!cleanMsg) return res.status(400).json({ error: "Message vide." });

    // 3) Vérif agent (table agents = source de vérité)
    const { data: agentRow, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name")
      .eq("slug", cleanSlug)
      .maybeSingle();

    if (agentErr || !agentRow) {
      return res.status(404).json({ error: "Agent introuvable." });
    }

    // 4) Récup config personnalisée (prompt + context) pour (user_id, agent_id)
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", userId)
      .eq("agent_id", agentRow.id)
      .maybeSingle();

    // Si pas de config => fallback sur prompt base
    const basePrompt = agentPrompts?.[cleanSlug]?.systemPrompt || `Tu es ${agentRow.name || cleanSlug}.`;
    const customPrompt = cfg?.system_prompt || "";
    const context = cfg?.context || null;

    const systemPrompt = buildSystemPrompt({ basePrompt, customPrompt, context });

    // 5) Appel Mistral
    const completion = await mistral.chat.complete({
      model: "mistral-small-latest",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: cleanMsg },
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
