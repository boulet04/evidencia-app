// pages/api/conversations/init.js
import { createClient } from "@supabase/supabase-js";

function safeStr(v) {
  return (v ?? "").toString();
}

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

/**
 * Extrait le prénom après une ligne du type :
 * - tu travaille pour "Simon"
 * - tu travailles pour Simon
 * - tu travail pour Simon   (variante fautive mais présente)
 * Tolère : guillemets, espaces, ponctuation.
 */
function extractFirstNameFromPrompt(systemPrompt) {
  const p = safeStr(systemPrompt);

  // 1) avec guillemets
  const reQuoted =
    /tu\s+(?:travail|travaill(?:e|es))\s+pour\s+["“'‘]([^"”'’]+)["”'’]/i;
  const m1 = p.match(reQuoted);
  if (m1?.[1]) return m1[1].trim();

  // 2) sans guillemets (prend le premier “mot prénom”, stoppe à ponctuation/fin)
  const reBare =
    /tu\s+(?:travail|travaill(?:e|es))\s+pour\s+([A-Za-zÀ-ÖØ-öø-ÿ-]+)\b/i;
  const m2 = p.match(reBare);
  if (m2?.[1]) return m2[1].trim();

  // 3) fallback plus permissif (jusqu'à fin de ligne, puis on prend le premier token)
  const reLine =
    /tu\s+(?:travail|travaill(?:e|es))\s+pour\s+([^\n\r]+)/i;
  const m3 = p.match(reLine);
  if (m3?.[1]) {
    const cleaned = m3[1]
      .replace(/[.,;:!?(){}\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const firstToken = cleaned.split(" ")[0] || "";
    return firstToken.trim();
  }

  return "";
}

function firstNameFromEmail(email) {
  const e = safeStr(email);
  const local = e.split("@")[0] || "";
  if (!local) return "";
  const clean = local.replace(/[._-]+/g, " ").trim();
  const first = clean.split(" ")[0] || "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "";
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant." });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant." });

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide." });

    const userId = userData.user.id;
    const userEmail = userData.user.email || "";

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const conversationId = safeStr(body.conversationId).trim();
    const agentSlug = safeStr(body.agentSlug).trim().toLowerCase();

    if (!conversationId) return res.status(400).json({ error: "conversationId manquant." });
    if (!agentSlug) return res.status(400).json({ error: "agentSlug manquant." });

    // Vérifier conversation ownership
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, user_id, agent_slug")
      .eq("id", conversationId)
      .maybeSingle();

    if (convErr || !conv) return res.status(404).json({ error: "Conversation introuvable." });
    if (conv.user_id !== userId) return res.status(403).json({ error: "Accès interdit." });
    if (conv.agent_slug !== agentSlug) return res.status(400).json({ error: "agentSlug ne correspond pas." });

    // Vérifier si conversation vide (user/assistant)
    const { data: existing, error: exErr } = await supabaseAdmin
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .in("role", ["user", "assistant"])
      .limit(1);

    if (exErr) return res.status(500).json({ error: "Erreur lecture messages." });
    if ((existing || []).length > 0) return res.status(200).json({ ok: true, skipped: true });

    // Charger agent
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, name")
      .eq("slug", agentSlug)
      .maybeSingle();

    if (agentErr || !agent) return res.status(404).json({ error: "Agent introuvable." });

    // Charger prompt personnalisé (source prioritaire pour le prénom)
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (cfgErr) return res.status(500).json({ error: "Erreur lecture client_agent_configs." });

    let firstName = extractFirstNameFromPrompt(cfg?.system_prompt || "");

    // Fallback uniquement si la ligne n’existe pas / prompt vide
    if (!firstName) firstName = firstNameFromEmail(userEmail);

    const agentDisplayName = agent.name || agentSlug;
    const greeting = firstName
      ? `Bonjour ${firstName}, je suis ${agentDisplayName}, comment puis-je vous aider ?`
      : `Bonjour, je suis ${agentDisplayName}, comment puis-je vous aider ?`;

    // Insert greeting as assistant message
    const { error: insErr } = await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: greeting,
      created_at: new Date().toISOString(),
    });

    if (insErr) return res.status(500).json({ error: "Erreur insertion message d'accueil." });

    return res.status(200).json({ ok: true, inserted: true, firstNameFound: Boolean(firstName) });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: safeStr(e?.message || e) });
  }
}
