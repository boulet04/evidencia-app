// pages/api/chat.js
import { createClient } from "@supabase/supabase-js";
import { Mistral } from "@mistralai/mistralai";
import agentPrompts from "../../lib/agentPrompts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

function normalizeContent(content) {
  // Mistral peut renvoyer string ou array (selon versions / formats)
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .join("")
      .trim();
  }
  return "";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode non autorisée." });
    }

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      return res.status(500).json({
        error:
          "Env manquantes Supabase (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY).",
      });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";

    if (!token) {
      return res.status(401).json({ error: "Non authentifié (token manquant)." });
    }

    const { message, agentSlug } = req.body || {};

    if (!agentSlug) {
      return res.status(400).json({ error: "Aucun agent sélectionné." });
    }
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: "Message vide." });
    }

    // 1) Vérifier l'utilisateur via Supabase Auth (avec l'anon key)
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const { data: userRes, error: userErr } = await supabaseAuth.auth.getUser(token);

    if (userErr || !userRes?.user) {
      return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    }

    const userId = userRes.user.id;
    const slug = String(agentSlug).trim().toLowerCase();

    // 2) Accès DB admin (service role) pour lire assignations + prompt
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // 2a) Charger agent
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (agentErr || !agent) {
      return res.status(404).json({ error: "Agent introuvable." });
    }

    // 2b) Vérifier assignation (si pas assigné => interdit)
    const { data: ua, error: uaErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (uaErr) {
      return res.status(500).json({ error: "Erreur lecture assignations." });
    }
    if (!ua) {
      return res.status(403).json({ error: "Accès interdit : agent non assigné." });
    }

    // 2c) Charger prompt personnalisé (si existant)
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("context")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (cfgErr) {
      return res.status(500).json({ error: "Erreur lecture configuration agent." });
    }

    const customPrompt =
      (cfg?.context && (cfg.context.prompt || cfg.context.systemPrompt)) || "";

    const fallbackPrompt =
      agentPrompts?.[slug]?.systemPrompt ||
      `Tu es ${agent.name}, ${agent.description || "assistant"}.\nRéponds en français.`;

    const systemPrompt = (customPrompt || fallbackPrompt).toString();

    // 3) Appel Mistral
    const completion = await mistral.chat.complete({
      model: "mistral-small-latest",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message.trim() },
      ],
      temperature: 0.7,
    });

    const reply = normalizeContent(completion?.choices?.[0]?.message?.content) || "Réponse vide.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat:", err);
    return res.status(500).json({
      error: err?.message ? `Erreur interne: ${err.message}` : "Erreur interne de l’agent.",
    });
  }
}
