// pages/api/chat.js
import { Mistral } from "@mistralai/mistralai";
import { createClient } from "@supabase/supabase-js";
import agentPrompts from "../../lib/agentPrompts";

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// Supabase admin (server-side) pour lire les configs même avec RLS
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode non autorisée." });
    }

    // 0) Vérif clés
    if (!process.env.MISTRAL_API_KEY) {
      return res.status(500).json({ error: "MISTRAL_API_KEY manquante (Vercel)." });
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error: "Clés Supabase serveur manquantes (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).",
      });
    }

    const { message, agentSlug } = req.body || {};
    const slug = (agentSlug || "").toString().trim().toLowerCase();
    const userMsg = (message || "").toString();

    if (!slug) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!userMsg.trim()) return res.status(400).json({ error: "Message vide." });

    // 1) Identifier le user via JWT Supabase (envoyé depuis le front)
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user?.id) {
      return res.status(401).json({ error: "Session invalide (token)." });
    }
    const userId = userData.user.id;

    // 2) Agent (table agents) pour récupérer agent_id
    const { data: agentRow, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (agentErr || !agentRow) {
      return res.status(404).json({ error: "Agent introuvable." });
    }

    // 3) Charger config personnalisée (prompt / data / workflow) si existe
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("context")
      .eq("user_id", userId)
      .eq("agent_id", agentRow.id)
      .maybeSingle();

    // Si erreur RLS / table, on n’explose pas : on continue sans custom
    const customPrompt = !cfgErr ? (cfg?.context?.prompt || "") : "";

    // 4) Prompt final
    const basePrompt = agentPrompts?.[slug]?.systemPrompt || "";
    const systemPrompt = [basePrompt, customPrompt].filter(Boolean).join("\n\n").trim();

    // 5) Appel Mistral
    const completion = await mistral.chat.complete({
      model: "mistral-small-latest",
      messages: [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        { role: "user", content: userMsg },
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
