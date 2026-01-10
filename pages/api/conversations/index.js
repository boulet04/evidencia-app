import { createClient } from "@supabase/supabase-js";

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function guessFromEmail(email) {
  if (!email) return "";
  const local = email.split("@")[0] || "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return "";
  const cand = parts[0].length <= 2 && parts[1] ? parts[1] : parts[0];
  return capitalize(cand);
}

/**
 * Extrait le nom après "Tu travailles pour ..."
 * Exemples détectés :
 *  - "Tu travailles pour Antoine"
 *  - "Tu travaille pour Antoine" (faute)
 *  - "Tu travailles pour Jean Baptiste, directeur..."
 */
function extractNameFromPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) return "";

  const m = prompt.match(
    /Tu\s+travaill(?:e|es)\s+pour\s+(.+?)(?:,|\n|$)/i
  );

  if (!m || !m[1]) return "";
  return m[1].trim();
}

/**
 * Récupère le "prénom / nom" pour le message d’accueil
 * Priorité :
 *  1) prompt perso agent (client_agent_configs.system_prompt) -> "Tu travailles pour X"
 *  2) user_metadata (si tu en mets un jour)
 *  3) fallback email (dernier recours)
 */
async function getWelcomeName({ supabaseAdmin, user, agent_slug }) {
  // 1) prompt perso agent
  const { data: agent, error: agentErr } = await supabaseAdmin
    .from("agents")
    .select("id")
    .eq("slug", agent_slug)
    .maybeSingle();

  if (!agentErr && agent?.id) {
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt")
      .eq("user_id", user.id)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (!cfgErr && cfg?.system_prompt) {
      const fromPrompt = extractNameFromPrompt(cfg.system_prompt);
      if (fromPrompt) return fromPrompt; // ex: "Antoine" ou "Jean Baptiste"
    }
  }

  // 2) user_metadata (optionnel)
  const md = user?.user_metadata || {};
  const metaName =
    md.first_name || md.prenom || md.firstname || md.given_name;

  if (typeof metaName === "string" && metaName.trim()) {
    // on garde seulement le 1er mot si tu mets "Jean Baptiste" ici
    // si tu veux garder tout, enlève le split
    return metaName.trim();
  }

  // 3) fallback email
  return guessFromEmail(user?.email || "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "Missing Bearer token" });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      error: "Server misconfiguration: missing SUPABASE env vars",
    });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: "Invalid token" });
  }

  const user = userData.user;

  const { agent_slug } = req.body || {};
  if (!agent_slug || typeof agent_slug !== "string") {
    return res.status(400).json({ error: "Missing agent_slug" });
  }

  // Optionnel : titre basé sur l’agent
  const { data: agentMeta } = await supabaseAdmin
    .from("agents")
    .select("name")
    .eq("slug", agent_slug)
    .maybeSingle();

  const title = agentMeta?.name ? `Discussion avec ${agentMeta.name}` : "Nouvelle conversation";

  // 1) Créer la conversation
  const { data: conv, error: convErr } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: user.id,
      agent_slug,
      title,
      archived: false,
    })
    .select("id,title,created_at,agent_slug")
    .single();

  if (convErr) return res.status(500).json({ error: convErr.message });

  // 2) Créer le message d’accueil basé sur le prompt perso
  const welcomeName = await getWelcomeName({ supabaseAdmin, user, agent_slug });

  const welcome = welcomeName
    ? `Bonjour ${welcomeName}, comment puis-je vous aider ?`
    : "Bonjour, comment puis-je vous aider ?";

  const { error: msgErr } = await supabaseAdmin.from("messages").insert({
    conversation_id: conv.id,
    role: "assistant",
    content: welcome,
  });

  if (msgErr) {
    return res.status(201).json({
      conversation: conv,
      warning: `Conversation created but welcome message failed: ${msgErr.message}`,
    });
  }

  return res.status(201).json({ conversation: conv });
}
