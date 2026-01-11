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

function isUuid(v) {
  const s = safeStr(v).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
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

function detectEmailMode(userMsg) {
  const t = safeStr(userMsg).toLowerCase();
  const send = /\b(envoie|envoyer|envoi)\b/.test(t);
  const draft = /\b(prépare|prepare|rédige|redige|brouillon|draft)\b/.test(t);
  if (send) return "SEND";
  if (draft) return "DRAFT";
  return "NORMAL";
}

async function resolveAgent({ userId, agentIdentifier, conversationId }) {
  let ident = safeStr(agentIdentifier).trim();

  // fallback via conversationId
  if (!ident && isUuid(conversationId)) {
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("agent_slug")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!convErr && conv?.agent_slug) ident = safeStr(conv.agent_slug).trim();
  }

  if (!ident) {
    return { agent: null, error: { status: 400, message: "Aucun agent sélectionné (agentSlug/agentId manquant)." } };
  }

  const slug = safeStr(ident).toLowerCase();

  // by slug
  let { data: agent, error: agentErr } = await supabaseAdmin
    .from("agents")
    .select("id, slug, name, description")
    .eq("slug", slug)
    .maybeSingle();

  if (!agentErr && agent) return { agent, error: null };

  // by uuid id
  if (isUuid(ident)) {
    const byId = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("id", ident)
      .maybeSingle();
    if (!byId.error && byId.data) return { agent: byId.data, error: null };
  }

  return { agent: null, error: { status: 404, message: `Agent introuvable (identifiant="${ident}").` } };
}

function normalizeHistoryRows(rows) {
  const out = [];
  for (const r of rows || []) {
    const role = safeStr(r.role).toLowerCase();
    const content = safeStr(r.content).trim();
    if (!content) continue;
    if (role === "user" || role === "assistant") out.push({ role, content });
  }
  return out;
}

/**
 * Construit (résumé + derniers messages) dans une limite de taille.
 * Retourne { messages, truncated, omittedMessages }
 */
function buildContextWithBudget({ summary, history, maxChars }) {
  // On part du plus récent vers l'ancien
  const reversed = [...history].reverse();

  let budget = maxChars;
  const selectedReversed = [];

  // Reserve un peu si on met un résumé
  const summaryBlock = summary ? `RÉSUMÉ DE CONVERSATION (mémoire longue)\n${summary}\n` : "";
  if (summaryBlock) budget -= summaryBlock.length;

  // Ajout des messages récents tant qu'on tient
  for (const m of reversed) {
    const chunk = `${m.role.toUpperCase()}: ${m.content}\n`;
    if (chunk.length > budget) break;
    selectedReversed.push(m);
    budget -= chunk.length;
  }

  const selected = selectedReversed.reverse();
  const truncated = selected.length < history.length;

  const omittedMessages = truncated ? history.slice(0, history.length - selected.length) : [];
  const summaryMsg = summaryBlock ? [{ role: "system", content: summaryBlock }] : [];

  return { messages: [...summaryMsg, ...selected], truncated, omittedMessages };
}

async function updateConversationSummary({ mistral, conversationId, oldSummary, omittedMessages }) {
  if (!isUuid(conversationId)) return;

  // Rien à résumer
  if (!omittedMessages?.length) return;

  // On résume uniquement ce qu'on a omis
  const toSummarize = omittedMessages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const summarizerPrompt = `
Tu es un outil de résumé.
Objectif: maintenir une mémoire longue et fidèle d'une conversation.
Règles:
- Résumé concis mais complet (faits, décisions, préférences, tâches, personnes, éléments techniques).
- Pas d'inventions. Si incertain, ne l'ajoute pas.
- Conserve les détails actionnables (URLs, identifiants, workflows, paramètres).
- Sortie: TEXTE (pas de JSON).
`;

  const completion = await mistral.chat.complete({
    model: process.env.MISTRAL_MODEL || "mistral-small-latest",
    messages: [
      { role: "system", content: summarizerPrompt.trim() },
      {
        role: "user",
        content:
          `Résumé existant (peut être vide):\n${oldSummary || ""}\n\n` +
          `Nouveaux éléments à intégrer au résumé:\n${toSummarize}\n\n` +
          `Produis le nouveau résumé fusionné.`,
      },
    ],
    temperature: 0.2,
  });

  const newSummary = completion?.choices?.[0]?.message?.content?.trim();
  if (!newSummary) return;

  await supabaseAdmin.from("conversations").update({ summary: newSummary }).eq("id", conversationId);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    if (!process.env.MISTRAL_API_KEY) return res.status(500).json({ error: "MISTRAL_API_KEY manquant sur Vercel." });
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant sur Vercel." });
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant sur Vercel." });

    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    const userId = userData.user.id;

    const body = req.body || {};
    const userMsg = safeStr(body?.message).trim();
    if (!userMsg) return res.status(400).json({ error: "Message vide." });

    const conversationId = safeStr(body?.conversationId ?? body?.conversation_id ?? "").trim();
    const agentIdentifier =
      body?.agentSlug ??
      body?.agent ??
      body?.agentId ??
      req.query?.agentSlug ??
      req.query?.agent ??
      req.query?.agentId ??
      "";

    const { agent, error: resolveErr } = await resolveAgent({ userId, agentIdentifier, conversationId });
    if (resolveErr) return res.status(resolveErr.status).json({ error: resolveErr.message });

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

    // Charger résumé conversation (mémoire longue) + historique
    let convSummary = "";
    let history = [];

    if (isUuid(conversationId)) {
      const { data: conv } = await supabaseAdmin
        .from("conversations")
        .select("summary")
        .eq("id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();

      convSummary = safeStr(conv?.summary).trim();

      const { data: rows } = await supabaseAdmin
        .from("messages")
        .select("role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(400);

      history = normalizeHistoryRows(rows);
    }

    const emailRules = `
MODE_EMAIL=${emailMode}

CAPACITÉ SYSTÈME
- Tu as la capacité d'envoyer un e-mail VIA MAKE/OUTLOOK quand MODE_EMAIL=SEND.
- Interdiction d'écrire : "je ne peux pas envoyer d'e-mails" ou équivalent.

RÈGLES DE SORTIE EMAIL
- Si MODE_EMAIL=DRAFT :
  - Produis un brouillon lisible structuré :
    Destinataire:
    Objet:
    Corps: (paragraphes séparés par une ligne vide)
  - Interdiction totale de renvoyer un JSON {to,subject,body}.
  - Termine par : "Si vous souhaitez l'envoyer, dites : envoie."

- Si MODE_EMAIL=SEND :
  - Renvoie UNIQUEMENT un JSON strict (aucun texte autour) avec EXACTEMENT :
    {"to":"...","subject":"...","body":"..."}
  - body doit être du HTML simple (<p>..</p><p>..</p>) pour un rendu email propre Outlook.
  - Si info manquante -> pose UNE question courte (au lieu d'inventer).
`;

    const finalSystemPrompt = [
      globalBasePrompt ? `INSTRUCTIONS GÉNÉRALES\n${globalBasePrompt}` : "",
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES\n${customPrompt}` : "",
      emailRules.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");

    // Budget de contexte (approx en caractères)
    const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 24000);

    const ctx = buildContextWithBudget({
      summary: convSummary,
      history,
      maxChars: MAX_CONTEXT_CHARS,
    });

    const mistralMessages = [
      { role: "system", content: finalSystemPrompt },
      ...ctx.messages,
      { role: "user", content: userMsg },
    ];

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: mistralMessages,
      temperature: 0.4,
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";

    // Mettre à jour le résumé si on a tronqué
    if (isUuid(conversationId) && ctx.truncated) {
      await updateConversationSummary({
        mistral,
        conversationId,
        oldSummary: convSummary,
        omittedMessages: ctx.omittedMessages,
      });
    }

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
