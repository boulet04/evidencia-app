// pages/api/chat.js
import { Mistral } from "@mistralai/mistralai";
import agentPrompts from "../../lib/agentPrompts";
import { createClient } from "@supabase/supabase-js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

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

async function getGlobalBasePrompt() {
  try {
    const { data, error } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "base_system_prompt")
      .maybeSingle();

    if (error) return "";
    return safeStr(data?.value).trim();
  } catch {
    return "";
  }
}

function isUuid(v) {
  const s = safeStr(v).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Détermine l'intention email (draft vs send)
 */
function detectEmailMode(userMsg) {
  const t = safeStr(userMsg).toLowerCase();
  const hasSend = /\b(envoie|envoyer|envoi)\b/i.test(t);
  const hasDraft = /\b(prépare|prepare|rédige|redige|brouillon|draft)\b/i.test(t);
  if (hasSend) return "SEND";
  if (hasDraft) return "DRAFT";
  return "NORMAL";
}

/**
 * Résolution robuste de l'agent :
 * - accepte slug texte (emma)
 * - accepte agentId uuid
 * - accepte conversationId uuid -> lit conversations.agent_slug
 */
async function resolveAgent({ userId, agentIdentifier, conversationId }) {
  let ident = safeStr(agentIdentifier).trim();

  // 1) Si ident absent : tenter via conversationId
  if (!ident && isUuid(conversationId)) {
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, user_id, agent_slug")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!convErr && conv?.agent_slug) {
      ident = safeStr(conv.agent_slug).trim();
    }
  }

  if (!ident) {
    return { agent: null, error: { status: 400, message: "Aucun agent sélectionné (agentSlug/agentId manquant)." } };
  }

  // 2) Essai par slug
  const slug = safeStr(ident).trim().toLowerCase();
  let { data: agent, error: agentErr } = await supabaseAdmin
    .from("agents")
    .select("id, slug, name, description")
    .eq("slug", slug)
    .maybeSingle();

  if (!agentErr && agent) return { agent, error: null };

  // 3) Si ident est UUID : essai par id
  if (isUuid(ident)) {
    const byId = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("id", ident)
      .maybeSingle();

    if (!byId.error && byId.data) return { agent: byId.data, error: null };
  }

  // 4) Agent introuvable
  return { agent: null, error: { status: 404, message: `Agent introuvable (identifiant="${ident}").` } };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    if (!process.env.MISTRAL_API_KEY) {
      return res.status(500).json({ error: "MISTRAL_API_KEY manquant sur Vercel." });
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant sur Vercel." });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant sur Vercel." });
    }

    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    }
    const userId = userData.user.id;

    const body = req.body || {};
    const userMsg = safeStr(body?.message).trim();

    // IMPORTANT : tolérer plusieurs champs envoyés par le front
    // (agentSlug / agent / agentId / conversationId)
    const agentIdentifier =
      body?.agentSlug ??
      body?.agent ??
      body?.agentId ??
      req.query?.agentSlug ??
      req.query?.agent ??
      req.query?.agentId ??
      "";

    const conversationId = body?.conversationId ?? body?.conversation_id ?? "";

    if (!userMsg) return res.status(400).json({ error: "Message vide." });

    // Résolution agent robuste
    const { agent, error: resolveErr } = await resolveAgent({
      userId,
      agentIdentifier,
      conversationId,
    });

    if (resolveErr) {
      return res.status(resolveErr.status).json({ error: resolveErr.message });
    }

    // Vérifier assignation
    const { data: assignment, error: assignErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (assignErr) return res.status(500).json({ error: "Erreur assignation (user_agents)." });
    if (!assignment) return res.status(403).json({ error: "Accès interdit : agent non assigné." });

    // Charger config user/agent
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
      safeStr(agentPrompts?.[agent.slug]?.systemPrompt).trim() ||
      `Tu es ${agent.name}${agent.description ? `, ${agent.description}` : ""}.`;

    const globalBasePrompt = await getGlobalBasePrompt();
    const emailMode = detectEmailMode(userMsg);

    // Bloc email : empêcher l'envoi quand on veut juste préparer
    const emailSafetyBlock = `
MODE_EMAIL=${emailMode}

RÈGLES EMAIL (IMPORTANTES)
- Si MODE_EMAIL=DRAFT :
  - Tu DOIS préparer un brouillon lisible (texte/markdown) avec :
    "Destinataire:", "Objet:", puis le corps en paragraphes.
  - Interdiction TOTALE de produire un JSON contenant EXACTEMENT les clés "to", "subject", "body".
  - Termine par : "Si vous souhaitez l'envoyer, dites simplement : envoie."
- Si MODE_EMAIL=SEND :
  - Tu DOIS renvoyer UNIQUEMENT un JSON strict (aucun texte autour) avec EXACTEMENT :
    {"to":"...","subject":"...","body":"..."}
  - "to" = email valide (une seule).
  - "body" = HTML (<p>, <br>, etc.) pour un rendu propre dans Outlook.
  - Si info manquante, pose UNE question courte au lieu de générer le JSON.
`;

    const finalSystemPrompt = [
      globalBasePrompt
        ? `INSTRUCTIONS GÉNÉRALES (communes à tous les agents)\n${globalBasePrompt}`
        : "",
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR :\n${customPrompt}` : "",
      emailSafetyBlock.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: [
        { role: "system", content: finalSystemPrompt },
        { role: "user", content: userMsg },
      ],
      temperature: 0.4,
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
