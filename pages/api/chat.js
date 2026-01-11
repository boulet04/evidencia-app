// pages/api/chat.js
import { createClient } from "@supabase/supabase-js";
import { Mistral } from "@mistralai/mistralai";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function safeJsonParse(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch {
    return { ok: false, value: null };
  }
}

function looksLikeSendConfirmation(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
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
    t.includes("envoie") ||
    t.includes("envoyer")
  );
}

function extractEmailJsonFromText(text) {
  if (!text) return null;

  // 1) cherche un bloc ```json ... ```
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    const p = safeJsonParse(fenced[1].trim());
    if (p.ok) return p.value;
  }

  // 2) cherche un objet JSON "simple" { ... } (dernier objet du texte)
  const all = text.match(/\{[\s\S]*\}/g);
  if (all && all.length) {
    for (let i = all.length - 1; i >= 0; i--) {
      const candidate = all[i];
      const p = safeJsonParse(candidate);
      if (p.ok) return p.value;
    }
  }

  return null;
}

function normalizeDraft(d) {
  if (!d || typeof d !== "object") return null;

  const to = (d.to || d.recipient || "").toString().trim();
  const subject = (d.subject || "").toString().trim();
  const body = (d.body || d.body_html || d.html || "").toString().trim();

  const missing = [];
  if (!to) missing.push("to");
  if (!subject) missing.push("subject");
  if (!body) missing.push("body");

  return { to, subject, body, missing };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
}

async function callMake({ to, subject, body }) {
  if (!MAKE_WEBHOOK_URL) {
    return { ok: false, status: 500, data: { ok: false, message: "MAKE_WEBHOOK_URL manquant" } };
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

async function getConversation(supabaseAdmin, conversationId) {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("id,user_id,agent_slug,title")
    .eq("id", conversationId)
    .single();

  if (error) return { ok: false, error: error.message, conversation: null };
  return { ok: true, conversation: data };
}

async function createConversation(supabaseAdmin, userId, agentSlug, firstText) {
  const title = (firstText || "").trim().slice(0, 60) || `Conversation avec ${agentSlug}`;
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .insert({ user_id: userId, agent_slug: agentSlug, title, archived: false })
    .select("id")
    .single();

  if (error || !data?.id) return { ok: false, error: error?.message || "create conversation failed" };
  return { ok: true, id: data.id };
}

async function loadHistory(supabaseAdmin, conversationId, limit = 40) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("role,content,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return { ok: false, error: error.message, messages: [] };
  return { ok: true, messages: data || [] };
}

function buildSystemPrompt(agentSlug) {
  return `
Tu es l’agent "${agentSlug}" dans une application pro. Tu dois rester cohérent avec l’historique.

Objectif EMAIL (strict) :
- Process en 2 temps OBLIGATOIRE : brouillon -> confirmation -> envoi.
- Ne JAMAIS envoyer tant que l’utilisateur n’a pas confirmé explicitement ("ENVOIE", "ok envoie", "oui envoie").
- Tu dois collecter et valider : destinataire (email), objet, corps.
- Si un champ manque, tu le demandes et tu n’inventes pas.
- Le corps doit être structuré en HTML (<p>..</p>, <br/>).

Quand tu as tout :
- Tu fournis un brouillon lisible + un bloc JSON pour Make au format EXACT :
\`\`\`json
{ "to": "...", "subject": "...", "body": "<p>...</p>" }
\`\`\`
- Puis tu demandes : "Souhaitez-vous que je l’envoie ? Répondez ENVOIE."

Si ce n’est pas une demande d’email, tu réponds normalement.
`.trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 500, { ok: false, error: "Supabase server env missing." });
  }
  if (!MISTRAL_API_KEY) {
    return sendJson(res, 500, { ok: false, error: "MISTRAL_API_KEY missing." });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const auth = await getUserFromBearer(supabaseAdmin, req);
  if (!auth.ok) return sendJson(res, 401, { ok: false, error: auth.error });

  let payload = req.body;
  if (typeof payload === "string") {
    const p = safeJsonParse(payload);
    payload = p.ok ? p.value : null;
  }
  if (!payload) return sendJson(res, 400, { ok: false, error: "Invalid JSON body" });

  const userText = (payload.message || payload.text || "").toString();
  const conversationIdIn = payload.conversation_id || payload.conversationId || null;
  let agentSlug = (payload.agent_slug || payload.agentSlug || "").toString();

  if (!userText.trim()) return sendJson(res, 400, { ok: false, error: "Message vide." });

  // conversation
  let conversationId = conversationIdIn ? String(conversationIdIn) : null;

  if (conversationId) {
    const conv = await getConversation(supabaseAdmin, conversationId);
    if (!conv.ok) return sendJson(res, 500, { ok: false, error: conv.error });

    if (conv.conversation.user_id !== auth.user.id) {
      return sendJson(res, 403, { ok: false, error: "Forbidden" });
    }

    // fallback agent slug from conversation if missing in request
    if (!agentSlug) agentSlug = conv.conversation.agent_slug || "";
  }

  // if still no agent slug: reject
  if (!agentSlug) return sendJson(res, 400, { ok: false, error: "Aucun agent sélectionné." });

  // if no conversationId => create
  if (!conversationId) {
    const created = await createConversation(supabaseAdmin, auth.user.id, agentSlug, userText);
    if (!created.ok) return sendJson(res, 500, { ok: false, error: created.error });
    conversationId = created.id;
  }

  // insert user message
  {
    const { error } = await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: userText,
    });
    if (error) return sendJson(res, 500, { ok: false, error: error.message });
  }

  // If user confirms send -> find last assistant JSON and call Make
  if (looksLikeSendConfirmation(userText)) {
    const hist = await loadHistory(supabaseAdmin, conversationId, 80);
    if (!hist.ok) return sendJson(res, 500, { ok: false, error: hist.error });

    // find last assistant message containing email json
    let lastDraft = null;
    for (let i = (hist.messages || []).length - 1; i >= 0; i--) {
      const m = hist.messages[i];
      if (m.role === "assistant") {
        const extracted = extractEmailJsonFromText(m.content || "");
        const norm = normalizeDraft(extracted);
        if (norm) {
          lastDraft = norm;
          break;
        }
      }
    }

    if (!lastDraft) {
      const txt =
        "Je ne trouve pas de brouillon à envoyer. Demandez-moi d’abord de préparer le mail (destinataire, objet, contenu).";
      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        content: txt,
      });
      return sendJson(res, 200, { ok: true, conversation_id: conversationId, reply: txt });
    }

    if (lastDraft.missing.length) {
      const txt =
        `Impossible d’envoyer : il manque ${lastDraft.missing.join(", ")}. ` +
        `Donnez-moi ces éléments et je prépare un brouillon complet.`;
      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        content: txt,
      });
      return sendJson(res, 200, { ok: true, conversation_id: conversationId, reply: txt });
    }

    if (!isValidEmail(lastDraft.to)) {
      const txt = `Adresse email destinataire invalide : "${lastDraft.to}". Corrigez-la, puis je renverrai le brouillon.`;
      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        content: txt,
      });
      return sendJson(res, 200, { ok: true, conversation_id: conversationId, reply: txt });
    }

    const make = await callMake({ to: lastDraft.to, subject: lastDraft.subject, body: lastDraft.body });

    const reply = make.ok
      ? `✅ Email envoyé via Outlook (Make).`
      : `❌ Échec envoi via Make (HTTP ${make.status}). ${make.data?.message ? `Message: ${make.data.message}` : ""}`;

    await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
    });

    return sendJson(res, 200, {
      ok: true,
      conversation_id: conversationId,
      reply,
      make: { ok: make.ok, status: make.status, data: make.data },
    });
  }

  // Normal: call Mistral with history
  const history = await loadHistory(supabaseAdmin, conversationId, 40);
  if (!history.ok) return sendJson(res, 500, { ok: false, error: history.error });

  const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });

  const systemPrompt = buildSystemPrompt(agentSlug);
  const messages = [
    { role: "system", content: systemPrompt },
    ...(history.messages || []).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  ];

  let assistantText = "";
  try {
    const completion = await mistral.chat.complete({
      model: "mistral-large-latest",
      messages,
      temperature: 0.2,
    });
    assistantText = completion?.choices?.[0]?.message?.content || "";
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e?.message || "Mistral error" });
  }

  if (!assistantText) assistantText = "Je n’ai pas de réponse pour l’instant.";

  // Store assistant
  {
    const { error } = await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: assistantText,
    });
    if (error) return sendJson(res, 500, { ok: false, error: error.message });
  }

  return sendJson(res, 200, { ok: true, conversation_id: conversationId, reply: assistantText });
}
