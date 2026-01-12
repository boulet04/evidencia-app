// pages/api/chat.js
import { createClient } from "@supabase/supabase-js";
import { Mistral } from "@mistralai/mistralai";

function safeStr(v) {
  return (v ?? "").toString();
}

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function nowIso() {
  return new Date().toISOString();
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t < Date.now();
}

function titleFromMessage(message) {
  const s = safeStr(message).trim().replace(/\s+/g, " ");
  if (!s) return "Nouvelle conversation";
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

function looksLikeEmail(s) {
  const v = safeStr(s).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function extractEmails(text) {
  const s = safeStr(text);
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const m = s.match(re);
  return Array.from(new Set((m || []).map((x) => x.trim())));
}

function isConfirmSend(text) {
  const t = safeStr(text).trim().toLowerCase();
  if (!t) return false;
  // volontairement strict et simple (vous utilisez "ok envoie")
  return (
    t === "ok envoie" ||
    t === "ok envoi" ||
    t === "ok, envoie" ||
    t === "ok, envoi" ||
    t === "envoie" ||
    t === "envoye" ||
    t === "envoyer" ||
    t === "oui envoie" ||
    t === "oui, envoie" ||
    t === "valide" ||
    t === "je confirme"
  );
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function buildMemoryTag(content) {
  return `MEMORY:\n${content}`;
}

function stripMemoryTag(content) {
  const t = safeStr(content);
  return t.startsWith("MEMORY:\n") ? t.slice("MEMORY:\n".length) : t;
}

function buildPendingEmailTag(obj) {
  return `PENDING_EMAIL:\n${JSON.stringify(obj)}`;
}

function parsePendingEmailTag(content) {
  const t = safeStr(content);
  if (!t.startsWith("PENDING_EMAIL:\n")) return null;
  const raw = t.slice("PENDING_EMAIL:\n".length).trim();
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Extrait un objet JSON d’un texte même si :
 * - enveloppé dans ```json ... ```
 * - enveloppé dans ``` ... ```
 * - précédé/suivi de texte
 * - ou si le modèle renvoie { ... } au milieu
 */
function extractFirstJsonObject(text) {
  const raw = safeStr(text).trim();
  if (!raw) return null;

  const fenceJson = new RegExp("```\\s*json\\s*([\\s\\S]*?)```", "i");
  const mJson = raw.match(fenceJson);
  if (mJson?.[1]) {
    const inside = mJson[1].trim();
    const parsed = tryParseJson(inside);
    if (parsed) return parsed;
  }

  const fenceAny = new RegExp("```\\s*([\\s\\S]*?)```", "i");
  const mAny = raw.match(fenceAny);
  if (mAny?.[1]) {
    const inside = mAny[1].trim();
    const parsed = tryParseJson(inside);
    if (parsed) return parsed;
  }

  const scanned = scanFirstBalancedObject(raw);
  if (scanned) {
    const parsed = tryParseJson(scanned);
    if (parsed) return parsed;
  }

  return null;
}

function tryParseJson(s) {
  const t = safeStr(s).trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  try {
    const obj = JSON.parse(t);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function scanFirstBalancedObject(text) {
  const s = safeStr(text);
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) return s.slice(start, i + 1);
    }
  }
  return null;
}

function htmlToText(html) {
  let t = safeStr(html);
  t = t.replace(/<\s*br\s*\/?>/gi, "\n");
  t = t.replace(/<\/p>\s*<p>/gi, "\n\n");
  t = t.replace(/<\/?p>/gi, "");
  t = t.replace(/<\/?div>/gi, "");
  t = t.replace(/<\/?strong>/gi, "");
  t = t.replace(/<\/?em>/gi, "");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function buildDraftPreview(draft) {
  const to = safeStr(draft.to || "").trim();
  const subject = safeStr(draft.subject || "").trim();
  const body =
    safeStr(draft.body || "").trim() ||
    (draft.body_html ? htmlToText(draft.body_html) : "");

  const lines = [];
  lines.push("Voici le brouillon du mail (non envoyé) :");
  lines.push("");
  lines.push(`- Destinataire : ${to || "[À COMPLETER]"}`);
  lines.push(`- Objet : ${subject || "[À COMPLETER]"}`);
  lines.push("");
  lines.push(body || "[Contenu à compléter]");
  lines.push("");
  lines.push('Si vous confirmez, écrivez "ok envoie" pour que je l’envoie.');
  return lines.join("\n");
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  const t0 = Date.now();

  try {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

    const MAKE_URL =
      process.env.MAKE_EMAIL_WEBHOOK_URL ||
      process.env.MAKE_WEBHOOK_URL ||
      process.env.MAKE_EMAIL_WEBHOOK ||
      "";

    const CHAT_MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";
    const SUMMARY_MODEL = process.env.MISTRAL_SUMMARY_MODEL || "mistral-small-latest";

    if (!SUPABASE_URL) return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant sur Vercel." });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant sur Vercel." });
    if (!MISTRAL_API_KEY) return res.status(500).json({ error: "MISTRAL_API_KEY manquant sur Vercel." });

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // AUTH
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    const userId = userData.user.id;

    // BODY
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const agentSlug = safeStr(body.agentSlug || body.agent_slug).trim().toLowerCase();
    const message = safeStr(body.message || body.content).trim();
    let conversationId = safeStr(body.conversationId || body.conversation_id).trim() || null;

    if (!agentSlug) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!message) return res.status(400).json({ error: "Message vide." });

    // PROFILE (admin + expiry)
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("role, expires_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (profileErr) return res.status(500).json({ error: "Erreur lecture profil.", detail: profileErr.message });

    const isAdmin = profile?.role === "admin";
    if (!isAdmin && isExpired(profile?.expires_at)) {
      return res.status(403).json({
        error: "Subscription expired",
        message: "Votre abonnement a expiré. Veuillez contacter Evidenc'IA pour renouveler votre abonnement.",
      });
    }

    // AGENT
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", agentSlug)
      .maybeSingle();

    if (agentErr) return res.status(500).json({ error: "Erreur lecture agent.", detail: agentErr.message });
    if (!agent) return res.status(404).json({ error: "Agent introuvable." });

    // ASSIGNMENT (non-admin)
    if (!isAdmin) {
      const { data: ua, error: uaErr } = await supabaseAdmin
        .from("user_agents")
        .select("id")
        .eq("user_id", userId)
        .eq("agent_id", agent.id)
        .maybeSingle();

      if (uaErr) return res.status(500).json({ error: "Erreur assignation (user_agents).", detail: uaErr.message });
      if (!ua) return res.status(403).json({ error: "Accès interdit : agent non assigné." });
    }

    // CONVERSATION
    if (conversationId) {
      const { data: conv, error: convErr } = await supabaseAdmin
        .from("conversations")
        .select("id, user_id, agent_slug")
        .eq("id", conversationId)
        .maybeSingle();

      if (convErr) return res.status(500).json({ error: "Erreur lecture conversation.", detail: convErr.message });

      if (!conv) conversationId = null;
      else if (!isAdmin && conv.user_id !== userId) return res.status(403).json({ error: "Conversation invalide (ownership)." });
      else if (conv.agent_slug !== agentSlug) return res.status(400).json({ error: "conversationId ne correspond pas à agentSlug." });
    }

    if (!conversationId) {
      const { data: newConv, error: newConvErr } = await supabaseAdmin
        .from("conversations")
        .insert({
          user_id: userId,
          agent_slug: agentSlug,
          title: titleFromMessage(message),
          archived: false,
        })
        .select("id")
        .single();

      if (newConvErr) {
        const { data: newConv2, error: newConvErr2 } = await supabaseAdmin
          .from("conversations")
          .insert({
            user_id: userId,
            agent_slug: agentSlug,
            title: titleFromMessage(message),
          })
          .select("id")
          .single();

        if (newConvErr2) return res.status(500).json({ error: "Création conversation impossible.", detail: newConvErr2.message });
        conversationId = newConv2.id;
      } else {
        conversationId = newConv.id;
      }
    }

    // SAVE user message
    const { error: insUserErr } = await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: message,
      created_at: nowIso(),
    });
    if (insUserErr) return res.status(500).json({ error: "Erreur insertion message user.", detail: insUserErr.message });

    // --- PENDING EMAIL (1) : confirmation => envoi direct du dernier brouillon pending ---
    // Récupère plusieurs PENDING_EMAIL pour trouver le dernier encore "pending"
    const { data: pendingRows } = await supabaseAdmin
      .from("messages")
      .select("content, created_at")
      .eq("conversation_id", conversationId)
      .eq("role", "system")
      .like("content", "PENDING_EMAIL:%")
      .order("created_at", { ascending: false })
      .limit(10);

    const pendingList = (pendingRows || [])
      .map((r) => parsePendingEmailTag(r.content))
      .filter(Boolean);

    const lastPending = pendingList.find((p) => p && p._state !== "sent") || null;

    // Cas "envoie le même mail à X" : si un email est présent dans le message, on duplique le dernier brouillon
    const emailsInMsg = extractEmails(message);
    const wantsReuse =
      /m[eê]me mail|m[eê]me email|renvoie|refait|même message|retransmets|envoie à/i.test(message);

    if (!isConfirmSend(message) && wantsReuse && emailsInMsg.length === 1 && lastPending) {
      const newDraft = { ...lastPending, to: emailsInMsg[0], _state: "pending", updated_at: nowIso() };

      const { error: pendInsErr } = await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "system",
        content: buildPendingEmailTag(newDraft),
        created_at: nowIso(),
      });
      if (pendInsErr) return res.status(500).json({ error: "Erreur stockage brouillon.", detail: pendInsErr.message });

      const assistantText = buildDraftPreview(newDraft);

      const { error: insAsstErr } = await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        content: assistantText,
        created_at: nowIso(),
      });
      if (insAsstErr) return res.status(500).json({ error: "Erreur insertion message assistant.", detail: insAsstErr.message });

      return res.status(200).json({
        ok: true,
        conversationId,
        reply: assistantText,
        mailSent: false,
        mailError: "",
        timings: { total_ms: Date.now() - t0, llm_ms: 0 },
        memory: { used: false, refreshed: false },
      });
    }

    if (isConfirmSend(message)) {
      if (!lastPending) {
        const assistantText = "Je n’ai aucun brouillon en attente dans cette conversation. Dites-moi le mail à préparer (destinataire + objet + contexte) et je vous le présenterai avant envoi.";
        await supabaseAdmin.from("messages").insert({
          conversation_id: conversationId,
          role: "assistant",
          content: assistantText,
          created_at: nowIso(),
        });
        return res.status(200).json({
          ok: true,
          conversationId,
          reply: assistantText,
          mailSent: false,
          mailError: "NO_PENDING",
          timings: { total_ms: Date.now() - t0, llm_ms: 0 },
          memory: { used: false, refreshed: false },
        });
      }

      // Validation stricte
      const to = safeStr(lastPending.to || "").trim();
      const subject = safeStr(lastPending.subject || "").trim();
      const bodyHtml =
        safeStr(lastPending.body_html || "").trim() ||
        (safeStr(lastPending.body || "").trim()
          ? `<p>${safeStr(lastPending.body).trim().replace(/\n{2,}/g, "\n\n").replace(/\n/g, "<br/>")}</p>`
          : "");

      if (!looksLikeEmail(to) || !subject || !bodyHtml) {
        const assistantText = "Je ne peux pas envoyer : brouillon incomplet (destinataire / objet / contenu). Dites-moi le destinataire exact (email) et/ou ce qu’il manque.";
        await supabaseAdmin.from("messages").insert({
          conversation_id: conversationId,
          role: "assistant",
          content: assistantText,
          created_at: nowIso(),
        });
        return res.status(200).json({
          ok: true,
          conversationId,
          reply: assistantText,
          mailSent: false,
          mailError: "INVALID_PENDING",
          timings: { total_ms: Date.now() - t0, llm_ms: 0 },
          memory: { used: false, refreshed: false },
        });
      }

      if (!MAKE_URL) {
        const assistantText = "Impossible d’envoyer : l’URL Make n’est pas configurée côté serveur (MAKE_WEBHOOK_URL manquante).";
        await supabaseAdmin.from("messages").insert({
          conversation_id: conversationId,
          role: "assistant",
          content: assistantText,
          created_at: nowIso(),
        });
        return res.status(200).json({
          ok: true,
          conversationId,
          reply: assistantText,
          mailSent: false,
          mailError: "MAKE_URL_MISSING",
          timings: { total_ms: Date.now() - t0, llm_ms: 0 },
          memory: { used: false, refreshed: false },
        });
      }

      // Envoi Make
      let mailSent = false;
      let mailError = "";

      const makeResp = await withTimeout(
        fetch(MAKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to,
            cc: Array.isArray(lastPending.cc) ? lastPending.cc : [],
            bcc: Array.isArray(lastPending.bcc) ? lastPending.bcc : [],
            subject,
            body_html: bodyHtml,
            meta: { conversationId, userId, agentSlug, ts: nowIso() },
          }),
        }),
        15000,
        "make_webhook"
      );

      const makeText = await makeResp.text().catch(() => "");
      if (!makeResp.ok) {
        mailError = `Make webhook error (${makeResp.status}) ${makeText || ""}`.slice(0, 400);
      } else {
        mailSent = true;
      }

      const assistantText = mailSent
        ? "Envoi confirmé : l’email a été transmis au workflow d’envoi. Vérifiez Indésirables/Spam et les Éléments envoyés du compte Outlook connecté à Make."
        : "Je n’ai pas pu envoyer l’email : le workflow a répondu une erreur. Je peux réessayer.";

      // Marquer le draft comme sent (pour éviter réutilisation involontaire)
      const sentMarker = { ...lastPending, _state: "sent", sent_at: nowIso() };
      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "system",
        content: buildPendingEmailTag(sentMarker),
        created_at: nowIso(),
      });

      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        content: assistantText,
        created_at: nowIso(),
      });

      return res.status(200).json({
        ok: true,
        conversationId,
        reply: assistantText,
        mailSent,
        mailError,
        timings: { total_ms: Date.now() - t0, llm_ms: 0 },
        memory: { used: false, refreshed: false },
      });
    }

    // --- MEMORY ---
    const { data: memRow } = await supabaseAdmin
      .from("messages")
      .select("id, content, created_at")
      .eq("conversation_id", conversationId)
      .eq("role", "system")
      .like("content", "MEMORY:%")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const memoryContent = memRow?.content ? stripMemoryTag(memRow.content) : "";
    const memoryCreatedAt = memRow?.created_at || null;

    let needMemoryUpdate = !memoryCreatedAt;

    if (memoryCreatedAt) {
      const { data: ids } = await supabaseAdmin
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationId)
        .in("role", ["user", "assistant"])
        .gt("created_at", memoryCreatedAt)
        .limit(12);

      if ((ids || []).length >= 12) needMemoryUpdate = true;
    }

    const HISTORY_LIMIT = 18;

    const { data: recentMsgs, error: recentErr } = await supabaseAdmin
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .not("content", "like", "MEMORY:%")
      .not("content", "like", "PENDING_EMAIL:%")
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);

    if (recentErr) return res.status(500).json({ error: "Erreur lecture historique.", detail: recentErr.message });

    const history = (recentMsgs || []).slice().reverse();

    const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });

    if (needMemoryUpdate) {
      const { data: sumMsgs, error: sumErr } = await supabaseAdmin
        .from("messages")
        .select("role, content, created_at")
        .eq("conversation_id", conversationId)
        .not("content", "like", "MEMORY:%")
        .not("content", "like", "PENDING_EMAIL:%")
        .order("created_at", { ascending: false })
        .limit(60);

      if (sumErr) return res.status(500).json({ error: "Erreur lecture messages pour résumé.", detail: sumErr.message });

      const sumHistory = (sumMsgs || []).slice().reverse();

      const summarizerSystem =
        "Tu es un moteur de synthèse. Produis un résumé court et utile en français.\n" +
        "- Format : puces courtes.\n" +
        "- Faits importants, décisions, contraintes, préférences, points en attente.\n" +
        "- Max 1200 caractères.\n" +
        "- Ne pas inventer.\n";

      const summarizerUser =
        (memoryContent ? `Mémoire précédente:\n${memoryContent}\n\n` : "") +
        "Voici le fil de conversation. Mets à jour la mémoire :\n\n" +
        sumHistory
          .map((m) => `${m.role.toUpperCase()}: ${safeStr(m.content).slice(0, 1200)}`)
          .join("\n");

      const sumResp = await withTimeout(
        mistral.chat.complete({
          model: SUMMARY_MODEL,
          temperature: 0.2,
          maxTokens: 450,
          messages: [
            { role: "system", content: summarizerSystem },
            { role: "user", content: summarizerUser },
          ],
        }),
        20000,
        "summary"
      );

      const newMemory = safeStr(sumResp?.choices?.[0]?.message?.content).trim();
      if (newMemory) {
        const { error: memInsErr } = await supabaseAdmin.from("messages").insert({
          conversation_id: conversationId,
          role: "system",
          content: buildMemoryTag(newMemory),
          created_at: nowIso(),
        });
        if (memInsErr) return res.status(500).json({ error: "Erreur écriture mémoire.", detail: memInsErr.message });
      }
    }

    const { data: memRow2 } = await supabaseAdmin
      .from("messages")
      .select("content")
      .eq("conversation_id", conversationId)
      .eq("role", "system")
      .like("content", "MEMORY:%")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const finalMemory = memRow2?.content ? stripMemoryTag(memRow2.content) : memoryContent;

    // --- SYSTEM PROMPT ---
    // Règles email renforcées : brouillon obligatoire + jamais d’envoi sans confirmation
    const workflowRules =
      "RÈGLES EMAIL (OBLIGATOIRES) :\n" +
      "- Quand l’utilisateur demande d’écrire/préparer un mail : tu dois d’abord présenter un BROUILLON (non envoyé) et demander confirmation.\n" +
      "- Tu n’envoies JAMAIS sans confirmation explicite de l’utilisateur.\n" +
      "- Tu ne mets jamais d’adresse email si elle n’a pas été donnée par l’utilisateur.\n" +
      "- Pour préparer un mail, renvoie un JSON (sans texte autour) avec exactement ces clés : to, subject, body.\n" +
      "- Si le destinataire manque : mets to à \"\" et pose UNE question : \"À quelle adresse email dois-je l’envoyer ?\".\n";

    const systemPrompt =
      `${workflowRules}\n` +
      `Tu es ${safeStr(agent.name) || "un agent"} d’Evidenc'IA. Réponds en français, de manière opérationnelle.\n` +
      (finalMemory ? `\nMÉMOIRE DE LA CONVERSATION:\n${finalMemory}\n` : "");

    const tBeforeLLM = Date.now();

    const completion = await withTimeout(
      mistral.chat.complete({
        model: CHAT_MODEL,
        temperature: 0.4,
        maxTokens: 900,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: message },
        ],
      }),
      25000,
      "chat"
    );

    let assistantText = safeStr(completion?.choices?.[0]?.message?.content).trim();
    if (!assistantText) assistantText = "Réponse vide.";

    // --- DRAFT EMAIL HANDLING ---
    // Le modèle doit renvoyer un JSON {to,subject,body}. On le transforme en preview + on stocke un pending draft.
    const obj = extractFirstJsonObject(assistantText);

    // Détection d’un “mail draft” sans action
    const isDraft =
      obj &&
      typeof obj === "object" &&
      Object.prototype.hasOwnProperty.call(obj, "to") &&
      Object.prototype.hasOwnProperty.call(obj, "subject") &&
      Object.prototype.hasOwnProperty.call(obj, "body");

    if (isDraft) {
      const to = safeStr(obj.to).trim();
      const subject = safeStr(obj.subject).trim();
      const body = safeStr(obj.body).trim();

      // Sécurité : on refuse un destinataire non fourni par l’utilisateur
      // => autorisé seulement si l’email a été vu dans les messages user (history) OU dans le message courant
      const userEmailsInHistory = [];
      for (const m of history) {
        if (m.role === "user") userEmailsInHistory.push(...extractEmails(m.content));
      }
      userEmailsInHistory.push(...extractEmails(message));
      const userProvided = userEmailsInHistory.includes(to);

      // Si to vide ou non fourni : on affiche le draft et on pose une question (sans stocker pending en envoi)
      if (!to || !looksLikeEmail(to) || !userProvided) {
        const draftPreview = buildDraftPreview({
          to: "",
          subject,
          body,
          _state: "pending",
        });

        // On stocke quand même le brouillon (sans destinataire) pour ne pas perdre le contenu
        const storeDraft = { to: "", subject, body, _state: "pending", created_at: nowIso() };
        await supabaseAdmin.from("messages").insert({
          conversation_id: conversationId,
          role: "system",
          content: buildPendingEmailTag(storeDraft),
          created_at: nowIso(),
        });

        const assistantOut =
          draftPreview +
          "\n\nÀ quelle adresse email dois-je l’envoyer ?";

        await supabaseAdmin.from("messages").insert({
          conversation_id: conversationId,
          role: "assistant",
          content: assistantOut,
          created_at: nowIso(),
        });

        return res.status(200).json({
          ok: true,
          conversationId,
          reply: assistantOut,
          mailSent: false,
          mailError: "",
          timings: {
            total_ms: Date.now() - t0,
            llm_ms: Date.now() - tBeforeLLM,
          },
          memory: {
            used: Boolean(finalMemory),
            refreshed: Boolean(needMemoryUpdate),
          },
        });
      }

      // Destinataire OK => on stocke un pending + on affiche le brouillon + demande confirmation
      const pendingDraft = {
        to,
        subject,
        body,
        body_html: `<p>${body.replace(/\n{2,}/g, "\n\n").replace(/\n/g, "<br/>")}</p>`,
        _state: "pending",
        created_at: nowIso(),
      };

      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "system",
        content: buildPendingEmailTag(pendingDraft),
        created_at: nowIso(),
      });

      const preview = buildDraftPreview(pendingDraft);

      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        content: preview,
        created_at: nowIso(),
      });

      return res.status(200).json({
        ok: true,
        conversationId,
        reply: preview,
        mailSent: false,
        mailError: "",
        timings: {
          total_ms: Date.now() - t0,
          llm_ms: Date.now() - tBeforeLLM,
        },
        memory: {
          used: Boolean(finalMemory),
          refreshed: Boolean(needMemoryUpdate),
        },
      });
    }

    // --- Normal assistant answer (non-draft) ---
    const { error: insAsstErr } = await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: assistantText,
      created_at: nowIso(),
    });

    if (insAsstErr) return res.status(500).json({ error: "Erreur insertion message assistant.", detail: insAsstErr.message });

    return res.status(200).json({
      ok: true,
      conversationId,
      reply: assistantText,
      mailSent: false,
      mailError: "",
      timings: {
        total_ms: Date.now() - t0,
        llm_ms: Date.now() - tBeforeLLM,
      },
      memory: {
        used: Boolean(finalMemory),
        refreshed: Boolean(needMemoryUpdate),
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: "Server error",
      details: safeStr(e?.message || e),
    });
  }
}
