// pages/api/chat.js
import { createClient } from "@supabase/supabase-js";
import { Mistral } from "@mistralai/mistralai";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

const META_DRAFT_PREFIX = "__META_EMAIL_DRAFT__:";
const META_SENT_PREFIX = "__META_EMAIL_SENT__:";

// ---- Helpers
function json(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function safeParseJSON(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch {
    return { ok: false, value: null };
  }
}

function looksLikeSendConfirmation(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  // confirmations typiques
  return (
    t === "envoie" ||
    t === "envoi" ||
    t === "ok envoie" ||
    t === "ok envoi" ||
    t === "oui envoie" ||
    t === "oui envoi" ||
    t === "envoie le mail" ||
    t === "envoie l'email" ||
    t === "envoie l’email" ||
    t === "envoie le courrier" ||
    t === "envoie-le" ||
    t.includes("envoie") ||
    t.includes("envoyer")
  );
}

function isMetaMessage(content) {
  return (
    typeof content === "string" &&
    (content.startsWith(META_DRAFT_PREFIX) || content.startsWith(META_SENT_PREFIX))
  );
}

function buildHumanDraftText({ to, subject, body_html, missing }) {
  const missingLine =
    missing && missing.length
      ? `\n\nÉléments manquants : ${missing.join(", ")}`
      : "";

  return (
    `Voici le brouillon prêt.\n\n` +
    `Destinataire : ${to || "(à renseigner)"}\n` +
    `Objet : ${subject || "(à renseigner)"}\n\n` +
    `Corps (HTML) :\n${body_html || "(à rédiger)"}\n\n` +
    `Souhaitez-vous que je l’envoie ? Répondez : ENVOIE` +
    missingLine
  );
}

async function callMakeSendEmail({ to, subject, body }) {
  if (!MAKE_WEBHOOK_URL) {
    return {
      ok: false,
      status: 500,
      data: { ok: false, message: "MAKE_WEBHOOK_URL manquant côté serveur." },
    };
  }

  const r = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, subject, body }),
  });

  let data = null;
  try {
    data = await r.json();
  } catch {
    // parfois Make renvoie vide : on gère
    data = { ok: r.ok, message: r.ok ? "sent" : "error" };
  }

  return { ok: r.ok, status: r.status, data };
}

async function getUserFromBearer(supabaseAdmin, req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { ok: false, error: "Missing Bearer token" };

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: "Invalid token" };

  return { ok: true, user: data.user };
}

async function ensureConversation({ supabaseAdmin, userId, agentSlug, conversationId, firstUserText }) {
  if (conversationId) return { ok: true, conversationId };

  const title =
    (firstUserText || "").trim().slice(0, 60) || `Conversation avec ${agentSlug}`;

  const { data, error } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: userId,
      agent_slug: agentSlug,
      title,
      archived: false,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    return { ok: false, error: error?.message || "Failed to create conversation" };
  }

  return { ok: true, conversationId: data.id };
}

async function loadConversationHistory({ supabaseAdmin, conversationId, limit = 30 }) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return { ok: false, error: error.message, messages: [] };

  const filtered = (data || []).filter((m) => !isMetaMessage(m.content));
  return { ok: true, messages: filtered };
}

async function findLastDraftMeta({ supabaseAdmin, conversationId }) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return { ok: false, error: error.message, draft: null };

  for (const m of data || []) {
    if (typeof m.content === "string" && m.content.startsWith(META_DRAFT_PREFIX)) {
      const raw = m.content.slice(META_DRAFT_PREFIX.length);
      const parsed = safeParseJSON(raw);
      if (parsed.ok) return { ok: true, draft: parsed.value };
    }
  }
  return { ok: true, draft: null };
}

function buildSystemPrompt(agentSlug) {
  // Base rules : email en 2 étapes + collecte obligatoire + HTML
  return `
Tu es l’agent "${agentSlug}" dans une application pro.
Tu DOIS rester cohérent avec l’historique de la conversation.

Règles EMAIL (strictes) :
- Tu NE DOIS JAMAIS envoyer un email sans confirmation explicite de l’utilisateur.
- Process obligatoire :
  1) Préparer un brouillon en collectant : destinataire (email), objet, contenu.
  2) Si un élément manque, tu le demandes. Tu n’inventes pas.
  3) Quand tout est prêt, tu demandes confirmation : "Répondez ENVOIE pour l’envoyer".
- Le corps doit être en HTML (paragraphes <p> et sauts <br/> si besoin), afin que l’email soit structuré dans Outlook.
- Quand l’utilisateur dit ENVOIE / ok envoie / oui envoie, tu ne rédiges pas un nouveau brouillon : tu confirmes l’envoi.

Format de sortie (JSON uniquement, sans markdown, sans texte autour) :
{
  "type": "chat" | "draft_email",
  "text": "texte pour l’utilisateur",
  "draft": {
    "to": "email",
    "subject": "objet",
    "body_html": "<p>...</p>"
  },
  "missing": ["to" | "subject" | "body_html"]
}

Si ce n’est pas une demande d’email : type="chat" et text uniquement.
`.trim();
}

async function callMistralJSON({ agentSlug, historyMessages }) {
  const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });

  const system = buildSystemPrompt(agentSlug);

  // Mistral attend { role, content }
  const msgs = [
    { role: "system", content: system },
    ...historyMessages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  ];

  const completion = await mistral.chat.complete({
    model: "mistral-large-latest",
    messages: msgs,
    temperature: 0.2,
  });

  const content = completion?.choices?.[0]?.message?.content ?? "";
  return content;
}

// ---- Handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(res, 500, { ok: false, error: "Supabase server env missing." });
  }
  if (!MISTRAL_API_KEY) {
    return json(res, 500, { ok: false, error: "MISTRAL_API_KEY missing." });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const auth = await getUserFromBearer(supabaseAdmin, req);
  if (!auth.ok) return json(res, 401, { ok: false, error: auth.error });

  const user = auth.user;

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return json(res, 400, { ok: false, error: "Invalid JSON body" });
  }

  const userText = (body?.message || "").toString();
  const agentSlug = (body?.agent_slug || "").toString();
  const incomingConversationId = body?.conversation_id ? String(body.conversation_id) : null;

  if (!agentSlug) return json(res, 400, { ok: false, error: "Aucun agent sélectionné." });
  if (!userText.trim()) return json(res, 400, { ok: false, error: "Message vide." });

  // Ensure conversation exists
  const conv = await ensureConversation({
    supabaseAdmin,
    userId: user.id,
    agentSlug,
    conversationId: incomingConversationId,
    firstUserText: userText,
  });
  if (!conv.ok) return json(res, 500, { ok: false, error: conv.error });

  const conversationId = conv.conversationId;

  // Insert user message
  {
    const { error } = await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: userText,
    });
    if (error) return json(res, 500, { ok: false, error: error.message });
  }

  // If it's a confirmation to SEND, we send the last draft via Make (server-side)
  if (looksLikeSendConfirmation(userText)) {
    const lastDraft = await findLastDraftMeta({ supabaseAdmin, conversationId });
    if (!lastDraft.ok) return json(res, 500, { ok: false, error: lastDraft.error });

    if (!lastDraft.draft) {
      const txt =
        "Je n’ai pas de brouillon récent à envoyer. Demandez-moi d’abord de préparer le mail (destinataire, objet, corps).";
      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        content: txt,
      });
      return json(res, 200, {
        ok: true,
        conversation_id: conversationId,
        assistant: { type: "chat", text: txt },
      });
    }

    const { to, subject, body_html, missing } = lastDraft.draft || {};
    const stillMissing = Array.isArray(missing) ? missing : [];

    if (!to || !subject || !body_html || stillMissing.length) {
      const txt =
        "Le brouillon n’est pas envoyable : il manque des éléments (destinataire/objet/corps). Je peux le compléter si vous me donnez les infos manquantes.";
      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        content: txt,
      });
      return json(res, 200, {
        ok: true,
        conversation_id: conversationId,
        assistant: { type: "chat", text: txt },
      });
    }

    const make = await callMakeSendEmail({ to, subject, body: body_html });

    const okText = make.ok
      ? `✅ Email envoyé via Outlook (Make).`
      : `❌ Échec d’envoi via Make (HTTP ${make.status}).`;

    // Store assistant visible confirmation
    await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: okText,
    });

    // Store meta
    await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: META_SENT_PREFIX + JSON.stringify({ ok: make.ok, status: make.status, data: make.data }),
    });

    return json(res, 200, {
      ok: true,
      conversation_id: conversationId,
      assistant: {
        type: "send_result",
        text: okText,
        make: { ok: make.ok, status: make.status, data: make.data },
      },
    });
  }

  // Normal path: load history, call Mistral expecting JSON
  const history = await loadConversationHistory({ supabaseAdmin, conversationId, limit: 30 });
  if (!history.ok) return json(res, 500, { ok: false, error: history.error });

  let modelRaw = "";
  try {
    modelRaw = await callMistralJSON({ agentSlug, historyMessages: history.messages });
  } catch (e) {
    const msg = e?.message || "Mistral error";
    return json(res, 500, { ok: false, error: msg });
  }

  // Parse model JSON
  const parsed = safeParseJSON(modelRaw);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    // Fallback: store raw
    await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: modelRaw || "Erreur : réponse vide du modèle.",
    });

    return json(res, 200, {
      ok: true,
      conversation_id: conversationId,
      assistant: { type: "chat", text: modelRaw || "Erreur : réponse vide du modèle." },
    });
  }

  const out = parsed.value;
  const type = out.type === "draft_email" ? "draft_email" : "chat";
  const text = (out.text || "").toString();

  if (type === "draft_email") {
    const draft = out.draft || {};
    const missing = Array.isArray(out.missing) ? out.missing : [];

    const to = (draft.to || "").toString();
    const subject = (draft.subject || "").toString();
    const body_html = (draft.body_html || "").toString();

    // Force HTML minimal to avoid Outlook plain block
    const normalizedBody =
      body_html && body_html.trim().startsWith("<")
        ? body_html
        : `<p>${(body_html || "").replace(/\n/g, "<br/>")}</p>`;

    const draftPayload = {
      to,
      subject,
      body_html: normalizedBody,
      missing,
    };

    const human = buildHumanDraftText(draftPayload);

    // Visible message
    await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: human,
    });

    // Meta message for reliable send
    await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: META_DRAFT_PREFIX + JSON.stringify(draftPayload),
    });

    return json(res, 200, {
      ok: true,
      conversation_id: conversationId,
      assistant: { type: "draft_email", text: human, draft: draftPayload },
    });
  }

  // Chat
  await supabaseAdmin.from("messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content: text || "…",
  });

  return json(res, 200, {
    ok: true,
    conversation_id: conversationId,
    assistant: { type: "chat", text: text || "…" },
  });
}
