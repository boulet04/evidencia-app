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

function safeStr(v) {
  return (v ?? "").toString();
}

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
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

function pickAgentSlug(reqBody, reqQuery) {
  const fromBody =
    safeStr(reqBody?.agentSlug).trim() ||
    safeStr(reqBody?.agent).trim() ||
    safeStr(reqBody?.slug).trim() ||
    safeStr(reqBody?.agent_slug).trim();

  const fromQuery =
    safeStr(reqQuery?.agent).trim() ||
    safeStr(reqQuery?.agentSlug).trim() ||
    safeStr(reqQuery?.slug).trim();

  return (fromBody || fromQuery).toLowerCase();
}

// ✅ Accepte "ENVOIE", "oui envoie", "ok envoie", "vas-y envoie", "envoie le mail", etc.
function isSendConfirmation(text) {
  const t = safeStr(text).trim().toLowerCase();

  // Eviter les faux positifs du type "prépare un mail et envoie-le après"
  // Ici on veut une intention claire d'envoi maintenant.
  const startsLikeConfirmation = /^(?:oui|ok|d'accord|dac|vas-y|vas y|go|parfait|super)\s+/.test(t);

  const normalized = t.replace(/\s+/g, " ").trim();

  // Cas 1: message = "envoie", "envoyer", "envoie le mail", "envoie à ...", etc.
  const direct =
    /^(envoi(e|er)|envoyer)\b/.test(normalized) ||
    /^(envoi(e|er)|envoyer)\s+(le|la|les|ce|cet|cette)\b/.test(normalized) ||
    /^(envoi(e|er)|envoyer)\s+mail\b/.test(normalized);

  // Cas 2: "oui envoie ..."
  const confirmPlusSend =
    startsLikeConfirmation && /^(?:oui|ok|d'accord|dac|vas-y|vas y|go|parfait|super)\s+(envoi(e|er)|envoyer)\b/.test(normalized);

  return direct || confirmPlusSend;
}

function extractFirstJsonObject(text) {
  const raw = safeStr(text).trim();
  if (!raw) return null;

  const m = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  if (m && m[1]) {
    try {
      return JSON.parse(m[1]);
    } catch {
      // continue
    }
  }

  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      return JSON.parse(raw);
    } catch {
      // continue
    }
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const slice = raw.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeEmailPayload(obj) {
  if (!obj || typeof obj !== "object") return null;
  const to = safeStr(obj.to).trim();
  const subject = safeStr(obj.subject).trim();
  const body = safeStr(obj.body).trim();
  if (!to || !subject || !body) return null;
  return { to, subject, body };
}

function getMakeWebhookUrl(ctxObj) {
  const direct =
    safeStr(ctxObj?.make_webhook_url).trim() ||
    safeStr(ctxObj?.makeWebhookUrl).trim() ||
    safeStr(ctxObj?.make_webhook).trim() ||
    safeStr(ctxObj?.webhook_url).trim() ||
    safeStr(ctxObj?.workflow_url).trim();

  const nested =
    safeStr(ctxObj?.make?.webhook_url).trim() ||
    safeStr(ctxObj?.make?.webhookUrl).trim();

  return direct || nested || "";
}

async function postToMakeWebhook(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const txt = await r.text().catch(() => "");
    if (!r.ok) return { ok: false, status: r.status, body: txt };
    return { ok: true, status: r.status, body: txt };
  } catch (e) {
    return { ok: false, status: 0, body: safeStr(e?.message || e) };
  } finally {
    clearTimeout(timeout);
  }
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

async function loadConversationHistory(conversationId, limit = 24) {
  if (!conversationId) return [];
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !Array.isArray(data)) return [];
  return data
    .map((m) => ({ role: safeStr(m.role).trim() || "user", content: safeStr(m.content) }))
    .filter((m) => m.content.trim().length > 0);
}

// ✅ Cherche le dernier JSON email valide dans les N derniers messages assistant
async function findLastAssistantEmailPayload(conversationId, lookback = 20) {
  if (!conversationId) return null;

  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(lookback);

  if (error || !Array.isArray(data)) return null;

  for (const row of data) {
    const content = safeStr(row?.content);
    const jsonObj = extractFirstJsonObject(content);
    const payload = normalizeEmailPayload(jsonObj);
    if (payload) return payload;
  }

  return null;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    if (!process.env.MISTRAL_API_KEY) {
      return res.status(500).json({ error: "MISTRAL_API_KEY manquant sur Vercel." });
    }

    const token = getBearerToken(req);
    if (!token) return res.status(200).json({ reply: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(200).json({ reply: "Session invalide. Reconnectez-vous." });
    const userId = userData.user.id;

    const body = req.body || {};
    const userMsg = safeStr(body.message).trim();
    const conversationId = safeStr(body.conversationId).trim();
    const slug = pickAgentSlug(body, req.query);

    if (!slug) return res.status(200).json({ reply: "Aucun agent sélectionné." });
    if (!userMsg) return res.status(200).json({ reply: "Message vide." });

    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (agentErr || !agent) return res.status(200).json({ reply: "Agent introuvable." });

    const { data: assignment } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (!assignment) return res.status(200).json({ reply: "Accès interdit : agent non assigné." });

    const { data: cfg } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    const ctxObj = parseMaybeJson(cfg?.context) || {};
    const makeUrl = getMakeWebhookUrl(ctxObj);

    // -------------------- MODE ENVOI (sans LLM) --------------------
    if (isSendConfirmation(userMsg)) {
      if (!conversationId) {
        return res.status(200).json({
          reply: "Je ne peux pas envoyer sans conversationId. Le front doit l’envoyer à /api/chat.",
        });
      }
      if (!makeUrl) {
        return res.status(200).json({
          reply: "Webhook Make absent. Mets-le dans le context JSON: make_webhook_url.",
        });
      }

      const payload = await findLastAssistantEmailPayload(conversationId, 30);
      if (!payload) {
        return res.status(200).json({
          reply:
            "Je ne trouve pas de brouillon JSON (to/subject/body) récent dans cette conversation. Demande d’abord “Prépare un mail à …”, puis confirme l’envoi.",
        });
      }

      const send = await postToMakeWebhook(makeUrl, payload);
      if (!send.ok) {
        return res.status(200).json({
          reply: `Échec d’envoi via Make (HTTP ${send.status}). Détail: ${send.body || "—"}`,
        });
      }

      return res.status(200).json({ reply: "Email envoyé via Outlook (Make)." });
    }

    // -------------------- MODE CHAT (avec historique) --------------------
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

    const hardEmailRule = `
RÈGLE EMAIL (INTÉGRATION MAKE)
- Tu peux préparer des emails (brouillon), mais TU N’ENVOIES JAMAIS tant que l’utilisateur ne confirme pas explicitement l’envoi (ex: "ENVOIE", "oui envoie", "ok envoie", "vas-y envoie").
- Quand on te demande de "préparer" ou "rédiger" un email: tu fournis (1) un brouillon lisible, puis (2) un bloc JSON strict dans un bloc \`\`\`json\`\`\` avec exactement: { "to": "...", "subject": "...", "body": "..." }.
- "body" doit être du HTML simple: <p>..., <br/>, <ul><li>...
- Si le destinataire manque, mets "to": "" et demande le destinataire.
`.trim();

    const systemPrompt = [
      globalBasePrompt ? `INSTRUCTIONS GÉNÉRALES\n${globalBasePrompt}` : "",
      hardEmailRule,
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES\n${customPrompt}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const history = await loadConversationHistory(conversationId, 30);

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.filter((m) => m.role === "user" || m.role === "assistant"),
      { role: "user", content: userMsg },
    ];

    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages,
      temperature: 0.7,
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
