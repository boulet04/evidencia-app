// pages/api/chat.js
import { createClient } from "@supabase/supabase-js";
import { Mistral } from "@mistralai/mistralai";

/**
 * Objectifs :
 * - Zéro "amnésie" : mémoire persistante par conversation (rolling summary stocké en DB)
 * - Performance : fenêtre courte de messages + mémoire, modèles "small" par défaut
 * - Envoi email : webhook Make réel, confirmation uniquement si Make répond OK
 * - Compat Vercel : accepte MAKE_WEBHOOK_URL (et MAKE_EMAIL_WEBHOOK_URL si présent)
 */

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

function tryParseActionJson(text) {
  const t = safeStr(text).trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  try {
    const obj = JSON.parse(t);
    if (!obj || typeof obj !== "object") return null;
    if (!obj.action) return null;
    return obj;
  } catch {
    return null;
  }
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
  // Tag clair pour filtrer via LIKE en PostgREST
  return `MEMORY:\n${content}`;
}

function stripMemoryTag(content) {
  const t = safeStr(content);
  return t.startsWith("MEMORY:\n") ? t.slice("MEMORY:\n".length) : t;
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
    // ENV
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

    // IMPORTANT : chez vous c’est MAKE_WEBHOOK_URL
    const MAKE_URL =
      process.env.MAKE_EMAIL_WEBHOOK_URL ||
      process.env.MAKE_WEBHOOK_URL ||
      "";

    // Modèles (rapides par défaut)
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
        // fallback si colonne archived absente
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

    // --- MEMORY (rolling summary) ---
    // 1) Charger la dernière mémoire
    const { data: memRow, error: memErr } = await supabaseAdmin
      .from("messages")
      .select("id, content, created_at")
      .eq("conversation_id", conversationId)
      .eq("role", "system")
      .like("content", "MEMORY:%")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (memErr) return res.status(500).json({ error: "Erreur lecture mémoire.", detail: memErr.message });

    const memoryContent = memRow?.content ? stripMemoryTag(memRow.content) : "";
    const memoryCreatedAt = memRow?.created_at || null;

    // 2) Déterminer s’il faut rafraîchir la mémoire
    // Rafraîchit si au moins 12 messages user/assistant depuis la dernière mémoire (ou si aucune mémoire)
    let needMemoryUpdate = !memoryCreatedAt;

    if (memoryCreatedAt) {
      const { data: countRows, error: countErr } = await supabaseAdmin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .in("role", ["user", "assistant"])
        .gt("created_at", memoryCreatedAt);

      if (countErr) return res.status(500).json({ error: "Erreur calcul rafraîchissement mémoire.", detail: countErr.message });
      const countSince = countRows?.length ?? 0; // head:true => souvent [], on exploite surtout count côté PostgREST
      // Certaines configs Supabase ne renvoient pas countRows. On force une stratégie stable :
      // si head:true ne donne pas count exploitable, on bascule sur un fetch limité.
      // Ici, si countRows est vide, on ne conclut pas ; on fait un fetch court.
      if (countSince >= 12) needMemoryUpdate = true;
      if (countSince === 0) {
        // fallback : fetch 12 ids after memoryCreatedAt
        const { data: ids, error: idsErr } = await supabaseAdmin
          .from("messages")
          .select("id")
          .eq("conversation_id", conversationId)
          .in("role", ["user", "assistant"])
          .gt("created_at", memoryCreatedAt)
          .limit(12);

        if (idsErr) return res.status(500).json({ error: "Erreur fallback rafraîchissement mémoire.", detail: idsErr.message });
        if ((ids || []).length >= 12) needMemoryUpdate = true;
      }
    }

    // 3) Charger une fenêtre d’historique pour le chat (rapide)
    // On envoie au modèle : mémoire + derniers 18 messages (hors mémoire)
    const HISTORY_LIMIT = 18;

    const { data: recentMsgs, error: recentErr } = await supabaseAdmin
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .not("content", "like", "MEMORY:%")
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);

    if (recentErr) return res.status(500).json({ error: "Erreur lecture historique.", detail: recentErr.message });

    const history = (recentMsgs || []).slice().reverse();

    // 4) Si besoin, générer une nouvelle mémoire (summary) et la stocker
    const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });

    if (needMemoryUpdate) {
      // On prend un extrait plus large pour résumer sans exploser en tokens
      const { data: sumMsgs, error: sumErr } = await supabaseAdmin
        .from("messages")
        .select("role, content, created_at")
        .eq("conversation_id", conversationId)
        .not("content", "like", "MEMORY:%")
        .order("created_at", { ascending: false })
        .limit(60);

      if (sumErr) return res.status(500).json({ error: "Erreur lecture messages pour résumé.", detail: sumErr.message });

      const sumHistory = (sumMsgs || []).slice().reverse();

      const summarizerSystem =
        "Tu es un moteur de synthèse. Produis un résumé court et utile en français.\n" +
        "Contraintes :\n" +
        "- Format : puces courtes.\n" +
        "- Contenu : faits importants, décisions, contraintes, préférences utilisateur, points en attente.\n" +
        "- Longueur : max 1200 caractères.\n" +
        "- Ne pas inventer.\n";

      const summarizerUser =
        (memoryContent ? `Mémoire précédente:\n${memoryContent}\n\n` : "") +
        "Voici le fil de conversation (extraits). Mets à jour la mémoire :\n\n" +
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

    // Relire la mémoire la plus récente (si on vient de la rafraîchir)
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

    // --- Prompt anti-hallucination d'exécution (email) ---
    const workflowRules =
      "RÈGLES D’EXÉCUTION (IMPORTANT) :\n" +
      "- Tu n’affirmes JAMAIS qu’un email a été envoyé si tu n’as pas reçu une confirmation d’exécution.\n" +
      "- Si l’utilisateur valide l’envoi d’un email ET que tu as toutes les infos, tu réponds UNIQUEMENT par un JSON brut (sans texte) au format :\n" +
      '{ "action":"send_email", "to":"email@domaine.com", "cc":[], "bcc":[], "subject":"...", "body_html":"<p>...</p>" }\n' +
      "- Si une info manque (destinataire, objet, contenu), tu poses UNE question précise.\n";

    const systemPrompt =
      `${workflowRules}\n` +
      `Tu es ${safeStr(agent.name) || "un agent"} d’Evidenc'IA. Réponds en français, de manière opérationnelle.\n` +
      (finalMemory ? `\nMÉMOIRE DE LA CONVERSATION (à respecter):\n${finalMemory}\n` : "");

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

    // --- ACTION : send_email ---
    let mailSent = false;
    let mailError = "";

    const action = tryParseActionJson(assistantText);

    if (action?.action === "send_email") {
      const to = safeStr(action.to).trim();
      const subject = safeStr(action.subject).trim();
      const bodyHtml = safeStr(action.body_html || action.body).trim();
      const cc = Array.isArray(action.cc) ? action.cc : [];
      const bcc = Array.isArray(action.bcc) ? action.bcc : [];

      if (!looksLikeEmail(to) || !subject || !bodyHtml) {
        mailError = "Payload email invalide (to/subject/body_html).";
        assistantText =
          "Je ne peux pas déclencher l’envoi car les paramètres email sont incomplets ou invalides (destinataire / objet / contenu).";
      } else if (!MAKE_URL) {
        mailError = "MAKE_WEBHOOK_URL non configurée.";
        assistantText =
          "Le workflow d’envoi d’email n’est pas configuré côté serveur (MAKE_WEBHOOK_URL manquante). Je peux préparer le mail, mais pas l’envoyer.";
      } else {
        const makeResp = await withTimeout(
          fetch(MAKE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to,
              cc,
              bcc,
              subject,
              body_html: bodyHtml,
              meta: {
                conversationId,
                userId,
                agentSlug,
                ts: nowIso(),
              },
            }),
          }),
          12000,
          "make_webhook"
        );

        const makeText = await makeResp.text().catch(() => "");
        if (!makeResp.ok) {
          mailError = `Make webhook error (${makeResp.status}) ${makeText || ""}`.slice(0, 300);
          assistantText =
            "Je n’ai pas pu envoyer l’email : le workflow a répondu une erreur. Je peux réessayer ou vous afficher le payload exact envoyé.";
        } else {
          mailSent = true;
          assistantText =
            "Email envoyé via le workflow automatique. Si vous ne le voyez pas, vérifiez le dossier Indésirables/Spam et les Éléments envoyés du compte Outlook connecté à Make.";
        }
      }
    }

    // SAVE assistant message
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
      mailSent,
      mailError,
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
