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

// IMPORTANT: on renvoie 200 pour les erreurs fonctionnelles afin de ne pas déclencher ton popup
function okReply(res, reply) {
  return res.status(200).json({ reply: safeStr(reply) });
}

function sanitizeAgentSlug(input) {
  let s = safeStr(input).trim();

  // cas: URL complète ou query string
  // ex: "https://.../chat?agent=emma" ou "chat?agent=emma"
  const m1 = s.match(/[?&]agent=([a-z0-9-_]+)/i);
  if (m1?.[1]) s = m1[1];

  // cas: "agent-emma"
  s = s.replace(/^agent[-_]/i, "");

  // ne garder que ce qui ressemble à un slug
  s = s.toLowerCase().match(/[a-z0-9-_]+/)?.[0] || "";

  return s;
}

function detectSendIntent(userMsg) {
  const t = safeStr(userMsg).toLowerCase();
  // "envoie" / "envoyer" etc, mais pas "prépare sans envoyer"
  const wantsSend = /\b(envoie|envoyer|envoi|expédie|expedie)\b/.test(t);
  const neg = /\b(ne\s+pas\s+envoyer|n[' ]?envoie\s+pas|sans\s+envoyer|prépare\s+sans\s+envoyer|prepare\s+sans\s+envoyer)\b/.test(t);
  return wantsSend && !neg;
}

function detectDraftIntent(userMsg) {
  const t = safeStr(userMsg).toLowerCase();
  // "prépare", "rédige", "écris" + mention mail/courrier
  const mailWord = /\b(mail|email|e-mail|courrier)\b/.test(t);
  const draftWord = /\b(prépare|prepare|rédige|redige|écris|ecris|rédaction|brouillon)\b/.test(t);
  return mailWord && draftWord;
}

function looksLikeHtml(s) {
  const t = safeStr(s).trim();
  return /<\/?(p|br|div|span|strong|em|ul|ol|li|table|tr|td|h1|h2|h3|html|body)\b/i.test(t);
}

function plainToHtml(plain) {
  const t = safeStr(plain).trim();
  if (!t) return "";
  const parts = t.split(/\n\s*\n+/g).map((p) => p.trim()).filter(Boolean);
  const escaped = parts.map((p) =>
    p
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br/>")
  );
  return escaped.map((p) => `<p>${p}</p>`).join("");
}

function extractJsonObject(text) {
  const t = safeStr(text).trim();
  if (!t) return null;

  // JSON pur
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      return JSON.parse(t);
    } catch {}
  }

  // bloc ```json ... ```
  const fence = t.match(/```json\s*([\s\S]*?)\s*```/i) || t.match(/```\s*([\s\S]*?)\s*```/);
  if (fence?.[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) {
      try {
        return JSON.parse(inner);
      } catch {}
    }
  }

  // extraction { ... }
  const curly = t.match(/\{[\s\S]*\}/);
  if (curly?.[0]) {
    try {
      return JSON.parse(curly[0]);
    } catch {}
  }

  return null;
}

function getMakeWebhookUrl(ctxObj) {
  const candidates = [
    ctxObj?.make_webhook_url,
    ctxObj?.makeWebhookUrl,
    ctxObj?.make?.webhookUrl,
    ctxObj?.make?.url,
    ctxObj?.workflows?.make?.webhookUrl,
    ctxObj?.workflows?.make?.url,
    ctxObj?.workflow?.make?.url,
    ctxObj?.workflow_url,
  ]
    .map((x) => safeStr(x).trim())
    .filter(Boolean);

  const fromEnv = safeStr(process.env.MAKE_WEBHOOK_URL).trim();
  if (fromEnv) candidates.push(fromEnv);

  // prioriser hook.make.com
  return (
    candidates.find((u) => /^https:\/\/hook\.[a-z0-9-]+\.make\.com\/.+/i.test(u)) ||
    candidates[0] ||
    ""
  );
}

async function postToMake(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await r.text().catch(() => "");
    if (!r.ok) throw new Error(`Make HTTP ${r.status} ${r.statusText} ${text ? `- ${text}` : ""}`.trim());
    return { ok: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadConversationHistory(conversationId, userId, limit = 30) {
  if (!conversationId) return { conv: null, history: [] };

  const { data: conv } = await supabaseAdmin
    .from("conversations")
    .select("id, user_id, agent_slug, title, archived, created_at")
    .eq("id", conversationId)
    .maybeSingle();

  if (!conv || conv.user_id !== userId) return { conv: null, history: [] };

  const { data: msgs } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(Math.max(limit, 1));

  const history = Array.isArray(msgs)
    ? msgs
        .map((m) => ({
          role: safeStr(m.role).toLowerCase(),
          content: safeStr(m.content),
        }))
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-limit)
    : [];

  return { conv, history };
}

function findLastEmailDraft(history) {
  // dernier assistant contenant {to,subject,body}
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "assistant") continue;
    const obj = extractJsonObject(m.content);
    const to = safeStr(obj?.to).trim();
    const subject = safeStr(obj?.subject).trim();
    const body = safeStr(obj?.body).trim();
    if (to && subject && body) return { to, subject, body };
  }
  return null;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    if (!process.env.MISTRAL_API_KEY) return res.status(500).json({ error: "MISTRAL_API_KEY manquant sur Vercel." });
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant sur Vercel." });
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant sur Vercel." });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    const userId = userData.user.id;

    const { message, agentSlug, conversationId } = req.body || {};
    const userMsg = safeStr(message).trim();
    if (!userMsg) return okReply(res, "Message vide.");

    const { conv, history } = await loadConversationHistory(conversationId, userId, 30);

    // slug depuis body OU depuis conversation
    const slug = sanitizeAgentSlug(agentSlug || conv?.agent_slug);
    if (!slug) return okReply(res, "Aucun agent sélectionné.");

    const { data: agent } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (!agent) return okReply(res, `Agent introuvable (${slug}).`);

    const { data: assignment, error: assignErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (assignErr) return res.status(500).json({ error: "Erreur assignation (user_agents)." });
    if (!assignment) return okReply(res, "Accès interdit : agent non assigné.");

    const { data: cfg } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    const ctxObj = parseMaybeJson(cfg?.context) || {};

    const sendIntent = detectSendIntent(userMsg);
    const draftIntent = detectDraftIntent(userMsg);

    // ENVOI (uniquement si "envoie")
    if (sendIntent) {
      const draft = findLastEmailDraft(history);
      if (!draft) {
        return okReply(res, "Je n’ai pas de brouillon prêt à envoyer dans cette conversation. Demandez d’abord : « prépare un mail à ... ».");
      }

      const makeUrl = getMakeWebhookUrl(ctxObj);
      if (!makeUrl) return res.status(500).json({ error: "Aucune URL Make webhook configurée (context ou MAKE_WEBHOOK_URL)." });

      let body = draft.body;
      if (!looksLikeHtml(body)) body = plainToHtml(body);

      await postToMake(makeUrl, { to: draft.to, subject: draft.subject, body });
      return okReply(res, "Email envoyé via Outlook (Make).");
    }

    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

    const globalBasePrompt = await getGlobalBasePrompt();
    const basePrompt =
      safeStr(agentPrompts?.[slug]?.systemPrompt).trim() ||
      `Tu es ${agent.name}${agent.description ? `, ${agent.description}` : ""}.`;

    const customPrompt =
      safeStr(cfg?.system_prompt).trim() ||
      safeStr(ctxObj?.prompt).trim() ||
      safeStr(ctxObj?.systemPrompt).trim() ||
      safeStr(ctxObj?.customPrompt).trim() ||
      "";

    // Règles email: si on est en "prépare", on force BROUILLON JSON ONLY, sinon conversation normale
    const emailDraftRules = `
EMAIL - MODE BROUILLON (SANS ENVOI)
- Tu prépares un brouillon, tu n'envoies rien.
- Tu réponds UNIQUEMENT par un JSON strict, sans texte autour, avec exactement:
  { "to": "<email>", "subject": "<objet>", "body": "<HTML>" }
- body doit être du HTML simple (<p>, <br/>), avec des paragraphes.
- Tu ne mets pas de placeholders type "[DATE A COMPLETER]" : si une info manque, tu fais au mieux sans la mettre.
`;

    const systemPrompt = [
      globalBasePrompt ? `INSTRUCTIONS GÉNÉRALES\n${globalBasePrompt}` : "",
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES\n${customPrompt}` : "",
      draftIntent ? emailDraftRules : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const messages = [{ role: "system", content: systemPrompt }];
    // mémoire conversation
    for (const m of history) messages.push({ role: m.role, content: m.content });
    messages.push({ role: "user", content: userMsg });

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages,
      temperature: 0.7,
    });

    const rawReply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";

    // si c'est un draft: on normalise en JSON pur
    if (draftIntent) {
      const obj = extractJsonObject(rawReply);
      if (!obj) {
        // on évite de casser l'UI: on renvoie un pseudo-brouillon minimal
        const minimal = {
          to: "",
          subject: "Objet à préciser",
          body: "<p>Indique-moi le destinataire (email) et l’objet exact, puis je rédige le brouillon.</p>",
        };
        return okReply(res, JSON.stringify(minimal));
      }

      let body = safeStr(obj.body).trim();
      if (body && !looksLikeHtml(body)) body = plainToHtml(body);

      const normalized = {
        to: safeStr(obj.to).trim(),
        subject: safeStr(obj.subject).trim(),
        body,
      };
      return okReply(res, JSON.stringify(normalized));
    }

    // conversation normale
    return okReply(res, rawReply);
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
