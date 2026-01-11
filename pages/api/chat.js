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

function isSendConfirmation(text) {
  const t = safeStr(text).trim().toLowerCase();
  // confirmation volontairement stricte
  return /^(ok\s*)?(oui\s*)?(envoi(e|er)?|envoie|envoyer)\s*!*$/i.test(t);
}

function stripMakeJsonBlocks(s) {
  const str = safeStr(s);
  return str.replace(/<make_json[\s\S]*?<\/make_json>/gi, "").trim();
}

function extractMakeJsonBlock(s) {
  const str = safeStr(s);
  const m = str.match(/<make_json[^>]*>([\s\S]*?)<\/make_json>/i);
  if (!m) return null;
  const raw = m[1].trim();
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function looksLikeHtml(s) {
  const t = safeStr(s);
  return /<\/?(p|br|div|span|strong|em|ul|ol|li|table|tr|td|h1|h2|h3|html|body)\b/i.test(t);
}

function escapeHtml(s) {
  return safeStr(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toHtmlParagraphs(plain) {
  const t = safeStr(plain).trim();
  if (!t) return "";
  const blocks = t.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks
    .map((b) => {
      const lines = b.split("\n").map((l) => escapeHtml(l));
      return `<p>${lines.join("<br/>")}</p>`;
    })
    .join("");
}

function isValidEmail(email) {
  const e = safeStr(email).trim();
  // Regex simple mais efficace pour validation client
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

async function postToMake(payload) {
  const url = process.env.MAKE_WEBHOOK_URL;
  if (!url) throw new Error("MAKE_WEBHOOK_URL manquant (Vercel).");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const ct = r.headers.get("content-type") || "";
    const text = await r.text().catch(() => "");

    let parsed = null;
    if (ct.includes("application/json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!r.ok) {
      const msg =
        parsed?.details ||
        parsed?.message ||
        text ||
        `HTTP ${r.status}`;
      throw new Error(msg.toString().slice(0, 500));
    }

    // si Make renvoie ok:false en 200 (certains préfèrent), on le gère aussi
    if (parsed && parsed.ok === false) {
      const msg = (parsed.details || parsed.message || "Erreur Make").toString().slice(0, 500);
      throw new Error(msg);
    }

    return { ok: true, data: parsed || { ok: true } };
  } finally {
    clearTimeout(timeout);
  }
}

async function getConversationById(conversationId) {
  if (!conversationId) return null;
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("id, user_id, agent_slug, title, archived, created_at")
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function getLatestConversationForUserAndAgent(userId, agentSlug) {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("id, user_id, agent_slug, title, archived, created_at")
    .eq("user_id", userId)
    .eq("agent_slug", agentSlug)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) return null;
  return data?.[0] || null;
}

function buildTitleFromFirstMessage(msg) {
  const stop = new Set(["bonjour", "salut", "hello", "coucou", "bonsoir", "hey", "yo"]);
  const words = safeStr(msg)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !stop.has(w));

  const picked = words.slice(0, 5);
  const title = picked.join(" ").trim();
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "Nouvelle conversation";
}

async function ensureConversation({ userId, agentSlug, conversationId, firstMessage }) {
  const existing = await getConversationById(conversationId);
  if (existing) {
    if (existing.user_id !== userId) return null;
    return existing;
  }

  if (agentSlug) {
    const latest = await getLatestConversationForUserAndAgent(userId, agentSlug);
    if (latest && latest.user_id === userId && !latest.archived) return latest;
  }

  if (!agentSlug) return null;

  const title = buildTitleFromFirstMessage(firstMessage);
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .insert([{ user_id: userId, agent_slug: agentSlug, title, archived: false }])
    .select("id, user_id, agent_slug, title, archived, created_at")
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

async function loadConversationMessages(conversationId, limit = 40) {
  if (!conversationId) return [];
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !data) return [];
  return data;
}

async function storeMessage(conversationId, role, content) {
  if (!conversationId) return;
  await supabaseAdmin.from("messages").insert([
    { conversation_id: conversationId, role, content: safeStr(content) },
  ]);
}

async function getLatestPendingEmail(conversationId) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "system")
    .like("content", "__PENDING_EMAIL__%")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) return null;
  const row = data?.[0];
  if (!row?.content) return null;

  const raw = safeStr(row.content).replace(/^__PENDING_EMAIL__/, "");
  const obj = parseMaybeJson(raw);
  return obj && typeof obj === "object" ? obj : null;
}

function validateEmailPayload(p) {
  const missing = [];
  const to = safeStr(p?.to).trim();
  const subject = safeStr(p?.subject).trim();
  const body = safeStr(p?.body).trim();

  if (!to) missing.push("adresse email destinataire");
  else if (!isValidEmail(to)) missing.push("adresse email destinataire (format invalide)");

  if (!subject) missing.push("objet");
  if (!body) missing.push("contenu du mail");

  return { ok: missing.length === 0, missing, normalized: { to, subject, body } };
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

    const body = req.body || {};
    const userMsg = safeStr(body.message).trim();
    const providedSlug = safeStr(body.agentSlug).trim().toLowerCase();
    const providedConversationId = safeStr(body.conversationId).trim();

    if (!userMsg) return res.status(400).json({ error: "Message vide." });

    // Déduire conversation/agent si possible
    let conversation = await getConversationById(providedConversationId);
    if (conversation && conversation.user_id !== userId) return res.status(403).json({ error: "Accès interdit : conversation invalide." });

    let slug = providedSlug;
    if (!slug && conversation?.agent_slug) slug = safeStr(conversation.agent_slug).trim().toLowerCase();

    if (!slug && !conversation) return res.status(400).json({ error: "Aucun agent sélectionné." });

    // Agent
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();
    if (agentErr || !agent) return res.status(404).json({ error: "Agent introuvable." });

    // Assignation
    const { data: assignment, error: assignErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();
    if (assignErr) return res.status(500).json({ error: "Erreur assignation (user_agents)." });
    if (!assignment) return res.status(403).json({ error: "Accès interdit : agent non assigné." });

    // Conversation
    if (!conversation) {
      conversation = await ensureConversation({
        userId,
        agentSlug: slug,
        conversationId: providedConversationId || "",
        firstMessage: userMsg,
      });
    }
    if (!conversation) return res.status(500).json({ error: "Impossible de créer/récupérer la conversation." });
    const conversationId = conversation.id;

    // Stocker le message user côté serveur (si votre front ne le fait pas déjà)
    await storeMessage(conversationId, "user", userMsg);

    // CONFIRMATION "ENVOIE" => envoyer le pending via Make
    if (isSendConfirmation(userMsg)) {
      const pending = await getLatestPendingEmail(conversationId);
      if (!pending) {
        const reply = "Je n’ai pas de brouillon d’email en attente dans cette conversation.";
        await storeMessage(conversationId, "assistant", reply);
        return res.status(200).json({ reply, conversationId });
      }

      const v = validateEmailPayload(pending);
      if (!v.ok) {
        const reply =
          `Je ne peux pas l’envoyer : il manque ou est invalide : ${v.missing.join(", ")}.\n` +
          `Dites-moi ces éléments et je régénère le brouillon.`;
        await storeMessage(conversationId, "assistant", reply);
        return res.status(200).json({ reply, conversationId });
      }

      const sendPayload = {
        to: v.normalized.to,
        subject: v.normalized.subject,
        body: looksLikeHtml(v.normalized.body) ? v.normalized.body : toHtmlParagraphs(v.normalized.body),
      };

      try {
        const makeRes = await postToMake(sendPayload);

        const reply = `Email envoyé via Outlook (Make) ✓`;
        await storeMessage(conversationId, "assistant", reply);
        // Optionnel : tracer le statut pour audit
        await storeMessage(conversationId, "system", `__MAKE_STATUS__${JSON.stringify(makeRes.data || { ok: true })}`);

        return res.status(200).json({ reply, conversationId, make: makeRes.data || { ok: true } });
      } catch (e) {
        const reply = `Échec d’envoi (Make) : ${safeStr(e.message || e).slice(0, 300)}`;
        await storeMessage(conversationId, "assistant", reply);
        return res.status(200).json({ reply, conversationId, make: { ok: false, error: safeStr(e.message || e) } });
      }
    }

    // Prompt perso
    const { data: cfg } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    const ctxObj = parseMaybeJson(cfg?.context);
    const customPrompt =
      safeStr(cfg?.system_prompt).trim() ||
      safeStr(ctxObj?.prompt).trim() ||
      safeStr(ctxObj?.systemPrompt).trim() ||
      safeStr(ctxObj?.customPrompt).trim() ||
      "";

    const basePrompt =
      safeStr(agentPrompts?.[slug]?.systemPrompt).trim() ||
      `Tu es ${agent.name}${agent.description ? `, ${agent.description}` : ""}.`;

    // RÈGLES email : collecte → brouillon → confirmation → envoi (jamais avant)
    const emailRule = `
WORKFLOW EMAIL — STRICT :
1) Collecte d’abord les informations. Champs obligatoires : (a) email destinataire, (b) objet, (c) contenu du mail.
   Champs conseillés : nom/prénom ou société du destinataire, signature, ton, dates, pièces jointes.
2) S’il manque UN champ obligatoire, pose des questions ciblées (liste courte) et NE RÉDIGE PAS le JSON.
3) Quand tu as tous les champs obligatoires :
   - Produis un BROUILLON lisible (bien structuré).
   - Termine par : "Souhaitez-vous que je l’envoie ? Répondez ENVOIE."
   - À la toute fin, ajoute un bloc EXACT :
     <make_json>{"to":"...","subject":"...","body":"...HTML..."}</make_json>
4) Tu n’envoies JAMAIS sans confirmation explicite "ENVOIE".
5) Le champ body doit être en HTML structuré : <p>...</p> et <br/> si besoin.
6) Le bloc <make_json> ne doit contenir QUE les clés : to, subject, body.`;

    const finalSystemPrompt = [
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES :\n${customPrompt}` : "",
      emailRule,
    ]
      .filter(Boolean)
      .join("\n\n");

    // Historique pour cohérence
    const historyRows = await loadConversationMessages(conversationId, 40);
    const history = historyRows
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: stripMakeJsonBlocks(m.content) }));

    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: [{ role: "system", content: finalSystemPrompt }, ...history],
      temperature: 0.7,
    });

    const rawReply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";

    // Extraction du <make_json> (si présent)
    const makeObj = extractMakeJsonBlock(rawReply);

    // Préparer réponse visible
    let reply = stripMakeJsonBlocks(rawReply);

    if (makeObj) {
      // Validation stricte avant de stocker pending
      const v = validateEmailPayload(makeObj);
      if (!v.ok) {
        // On empêche l’envoi futur et on force une demande de compléments
        reply =
          `${reply}\n\n` +
          `Je ne peux pas préparer l’envoi car il manque ou est invalide : ${v.missing.join(", ")}.\n` +
          `Donnez-moi ces éléments et je mets à jour le brouillon.`;
      } else {
        const pending = {
          to: v.normalized.to,
          subject: v.normalized.subject,
          body: looksLikeHtml(v.normalized.body) ? v.normalized.body : toHtmlParagraphs(v.normalized.body),
        };
        await storeMessage(conversationId, "system", `__PENDING_EMAIL__${JSON.stringify(pending)}`);
      }
    }

    await storeMessage(conversationId, "assistant", reply);

    return res.status(200).json({ reply, conversationId });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}

