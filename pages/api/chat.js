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

function detectSendIntent(userMsg) {
  const t = safeStr(userMsg).toLowerCase();
  return (
    /\b(envoie|envoyer|envoi|expédie|expedie|envoie\s+le\s+mail|envoie\s+un\s+mail)\b/.test(t) &&
    !/\b(ne\s+pas\s+envoyer|n[' ]?envoie\s+pas|sans\s+envoyer|prépare\s+sans\s+envoyer)\b/.test(t)
  );
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

  // Cas 1: JSON pur
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      return JSON.parse(t);
    } catch {
      /* ignore */
    }
  }

  // Cas 2: bloc ```json ... ```
  const fence = t.match(/```json\s*([\s\S]*?)\s*```/i) || t.match(/```\s*([\s\S]*?)\s*```/);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) {
      try {
        return JSON.parse(inner);
      } catch {
        /* ignore */
      }
    }
  }

  // Cas 3: tentative extraction naive { ... }
  const curly = t.match(/\{[\s\S]*\}/);
  if (curly && curly[0]) {
    try {
      return JSON.parse(curly[0]);
    } catch {
      /* ignore */
    }
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

  return candidates.find((u) => /^https:\/\/hook\.[a-z0-9-]+\.make\.com\/.+/i.test(u)) || candidates[0] || "";
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

  const { data: conv, error: convErr } = await supabaseAdmin
    .from("conversations")
    .select("id, user_id, agent_slug, title, archived, created_at")
    .eq("id", conversationId)
    .maybeSingle();

  if (convErr || !conv) return { conv: null, history: [] };
  if (conv.user_id !== userId) return { conv: null, history: [] };

  const { data: msgs, error: msgErr } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(Math.max(limit, 1));

  if (msgErr || !Array.isArray(msgs)) return { conv, history: [] };

  const history = msgs
    .map((m) => ({
      role: safeStr(m.role).toLowerCase(),
      content: safeStr(m.content),
    }))
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-limit);

  return { conv, history };
}

function findLastEmailDraft(history) {
  // On cherche le dernier message assistant qui contient un JSON {to,subject,body}
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

    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    const userId = userData.user.id;

    const { message, agentSlug, conversationId } = req.body || {};
    const userMsg = safeStr(message).trim();
    if (!userMsg) return res.status(400).json({ error: "Message vide." });

    const sendIntent = detectSendIntent(userMsg);

    const { conv, history } = await loadConversationHistory(conversationId, userId, 30);
    const slug = safeStr(agentSlug || conv?.agent_slug).trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: "Aucun agent sélectionné." });

    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();
    if (agentErr || !agent) return res.status(404).json({ error: "Agent introuvable." });

    const { data: assignment, error: assignErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();
    if (assignErr) return res.status(500).json({ error: "Erreur assignation (user_agents)." });
    if (!assignment) return res.status(403).json({ error: "Accès interdit : agent non assigné." });

    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();
    const ctxObj = !cfgErr ? parseMaybeJson(cfg?.context) : null;

    // 1) Si l'utilisateur dit "ENVOIE" -> on tente d'envoyer le dernier brouillon existant
    if (sendIntent) {
      const draft = findLastEmailDraft(history);
      if (!draft) {
        return res.status(200).json({
          reply: "Je n’ai pas de brouillon d’email prêt à envoyer dans cette conversation. Demandez d’abord : « prépare un mail à … ».",
        });
      }

      const makeUrl = getMakeWebhookUrl(ctxObj || {});
      if (!makeUrl) {
        return res.status(500).json({
          error: "Aucune URL Make webhook configurée (context ou MAKE_WEBHOOK_URL).",
        });
      }

      let body = draft.body;
      if (!looksLikeHtml(body)) body = plainToHtml(body);

      await postToMake(makeUrl, { to: draft.to, subject: draft.subject, body });
      return res.status(200).json({ reply: "Email envoyé via Outlook (Make)." });
    }

    // 2) Sinon: on génère un brouillon (JSON strict) stockable, mais NON envoyé
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

    const serverSafety = `
EMAIL - MODE BROUILLON (SANS ENVOI)
- Tu dois préparer un brouillon d'email, mais tu n'envoies rien.
- Tu réponds UNIQUEMENT par un JSON strict, sans texte autour, avec exactement:
  { "to": "<email>", "subject": "<objet>", "body": "<HTML>" }
- body doit être un HTML simple (<p>, <br/>).
- Si le destinataire n'est pas clair, mets "to" à "" et demande UNE question courte ensuite (mais toujours JSON strict, en mettant un champ subject/body quand même).
`;

    const systemPrompt = [
      globalBasePrompt ? `INSTRUCTIONS GÉNÉRALES\n${globalBasePrompt}` : "",
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES\n${customPrompt}` : "",
      serverSafety,
    ]
      .filter(Boolean)
      .join("\n\n");

    const messages = [{ role: "system", content: systemPrompt }];
    for (const m of history) {
      messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: "user", content: userMsg });

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages,
      temperature: 0.7,
    });

    const rawReply = completion?.choices?.[0]?.message?.content?.trim() || "";

    // Normalisation HTML si besoin
    const obj = extractJsonObject(rawReply);
    if (obj) {
      let body = safeStr(obj.body).trim();
      if (body && !looksLikeHtml(body)) body = plainToHtml(body);
      const normalized = {
        to: safeStr(obj.to).trim(),
        subject: safeStr(obj.subject).trim(),
        body,
      };
      return res.status(200).json({ reply: JSON.stringify(normalized) });
    }

    // Si le modèle n'a pas respecté JSON
    return res.status(200).json({
      reply:
        "Je n’ai pas pu produire un brouillon structuré. Reformule en précisant: destinataire, objet, contenu. Exemple: « prépare un mail à prenom.nom@domaine.com, objet: ..., contenu: ... »",
    });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
