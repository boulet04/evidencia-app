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

function extractEmailFromText(text) {
  const s = safeStr(text);
  const m = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : "";
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

  // 1) Chercher un bloc ```json ... ```
  const fenceJson = new RegExp("```\\s*json\\s*([\\s\\S]*?)```", "i");
  const mJson = raw.match(fenceJson);
  if (mJson?.[1]) {
    const inside = mJson[1].trim();
    const parsed = tryParseJson(inside);
    if (parsed) return parsed;
  }

  // 2) Chercher un bloc ``` ... ``` (sans préciser json)
  const fenceAny = new RegExp("```\\s*([\\s\\S]*?)```", "i");
  const mAny = raw.match(fenceAny);
  if (mAny?.[1]) {
    const inside = mAny[1].trim();
    const parsed = tryParseJson(inside);
    if (parsed) return parsed;
  }

  // 3) Chercher un objet JSON par scan d’accolades (top-level)
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
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
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
      if (depth === 0 && start !== -1) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractAction(text) {
  const obj = extractFirstJsonObject(text);
  if (!obj || typeof obj !== "object") return null;
  if (!obj.action) return null;
  return obj;
}

const PENDING_EMAIL_PREFIX = "PENDING_EMAIL:";

function buildPendingEmailTag(payloadObj) {
  return `${PENDING_EMAIL_PREFIX}${JSON.stringify(payloadObj)}`;
}

function parsePendingEmailTag(content) {
  const t = safeStr(content);
  if (!t.startsWith(PENDING_EMAIL_PREFIX)) return null;
  const json = t.slice(PENDING_EMAIL_PREFIX.length).trim();
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function isConfirmSend(message) {
  const m = safeStr(message).trim().toLowerCase();
  return m === "ok envoie" || m === "ok envoi" || m === "ok, envoie" || m === "ok, envoi";
}

function makeDraftPreview(draft, agentName) {
  const to = safeStr(draft.to || "").trim();
  const subject = safeStr(draft.subject || "").trim();
  const bodyHtml = safeStr(draft.body_html || "").trim();

  const toLine = to ? to : "[À compléter]";
  const subjectLine = subject ? subject : "[Objet à compléter]";

  return (
    `Voici le brouillon du mail (non envoyé) :\n\n` +
    `- Destinataire : ${toLine}\n` +
    `- Objet : ${subjectLine}\n\n` +
    `---\n` +
    `${stripHtmlForPreview(bodyHtml)}\n` +
    `---\n\n` +
    (!to
      ? `Indiquez l’adresse email du destinataire (ex: prenom.nom@entreprise.com). Ensuite, écrivez "ok envoie" pour confirmer l’envoi.`
      : `Si vous confirmez, écrivez "ok envoie" pour que ${agentName || "l’agent"} l’envoie.`)
  );
}

// Petit rendu texte lisible pour l’aperçu (sans dépendance)
function stripHtmlForPreview(html) {
  const s = safeStr(html);
  if (!s) return "(contenu vide)";
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

    const MAKE_URL = process.env.MAKE_EMAIL_WEBHOOK_URL || process.env.MAKE_WEBHOOK_URL || "";

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
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
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

    // CONVERSATION ownership
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

    // Create conv if missing
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

    // --- Pending email fast-path (sans LLM) ---
    // Si l'utilisateur écrit une adresse email, on l'utilise comme destinataire du dernier brouillon en attente.
    // Si l'utilisateur écrit "ok envoie", on envoie uniquement si un brouillon valide existe.
    const userEmailProvided = extractEmailFromText(message);
    const userConfirm = isConfirmSend(message);

    const { data: pendingRow } = await supabaseAdmin
      .from("messages")
      .select("id, content, created_at")
      .eq("conversation_id", conversationId)
      .eq("role", "system")
      .like("content", `${PENDING_EMAIL_PREFIX}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let pendingDraft = pendingRow?.content ? parsePendingEmailTag(pendingRow.content) : null;

    // Si l'utilisateur fournit une adresse (et qu'il y a un brouillon sans destinataire)
    if (pendingDraft && userEmailProvided && !looksLikeEmail(pendingDraft.to || "")) {
      pendingDraft.to = userEmailProvided;

      await supabaseAdmin.from("messages").insert({
        conversation_id: conversationId,
        role: "system",
        content: buildPendingEmailTag(pendingDraft),
        created_at: nowIso(),
      });

      const assistantText = makeDraftPreview(pendingDraft, safeStr(agent.name));

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
        mailError: "",
        timings: { total_ms: Date.now() - t0, llm_ms: 0 },
        memory: { used: true, refreshed: false },
      });
    }

    // Si l'utilisateur confirme l'envoi
    if (userConfirm) {
      let assistantText = "";
      let mailSent = false;
      let mailError = "";

      if (!pendingDraft) {
        assistantText =
          "Je n’ai aucun brouillon en attente à envoyer. Dites-moi quel mail vous souhaitez rédiger (objet + contexte) et je vous afficherai le brouillon avant confirmation.";
      } else {
        const to = safeStr(pendingDraft.to).trim();
        const subject = safeStr(pendingDraft.subject).trim();
        const bodyHtml = safeStr(pendingDraft.body_html || pendingDraft.body).trim();
        const cc = Array.isArray(pendingDraft.cc) ? pendingDraft.cc : [];
        const bcc = Array.isArray(pendingDraft.bcc) ? pendingDraft.bcc : [];

        if (!looksLikeEmail(to) || !subject || !bodyHtml) {
          assistantText =
            "Je ne peux pas envoyer : il manque des informations (destinataire / objet / contenu). Donnez-moi l’adresse email du destinataire et/ou les éléments manquants, puis confirmez à nouveau avec \"ok envoie\".";
        } else if (!MAKE_URL) {
          assistantText =
            "Le workflow d’envoi d’email n’est pas configuré côté serveur (MAKE_WEBHOOK_URL manquante). Je peux afficher le brouillon, mais pas envoyer.";
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
                meta: { conversationId, userId, agentSlug, ts: nowIso() },
              }),
            }),
            12000,
            "make_webhook"
          );

          const makeText = await makeResp.text().catch(() => "");
          if (!makeResp.ok) {
            mailError = `Make webhook error (${makeResp.status}) ${makeText || ""}`.slice(0, 400);
            assistantText =
              "Je n’ai pas pu envoyer l’email : le workflow a répondu une erreur. Je peux réessayer ou vous afficher le payload exact.";
          } else {
            mailSent = true;
            assistantText =
              "Envoi confirmé : l’email a été transmis au workflow d’envoi. Vérifiez Indésirables/Spam et les Éléments envoyés du compte Outlook connecté à Make.";
          }
        }
      }

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
        memory: { used: true, refreshed: false },
      });
    }

    // --- MEMORY ---
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

    let needMemoryUpdate = !memoryCreatedAt;

    if (memoryCreatedAt) {
      const { data: ids, error: idsErr } = await supabaseAdmin
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationId)
        .in("role", ["user", "assistant"])
        .gt("created_at", memoryCreatedAt)
        .limit(12);

      if (idsErr) return res.status(500).json({ error: "Erreur rafraîchissement mémoire.", detail: idsErr.message });
      if ((ids || []).length >= 12) needMemoryUpdate = true;
    }

    const HISTORY_LIMIT = 18;

    const { data: recentMsgs, error: recentErr } = await supabaseAdmin
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .not("content", "like", "MEMORY:%")
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);

    if (recentErr) return res.status(500).json({ error: "Erreur lecture historique.", detail: recentErr.message });

    // IMPORTANT : on exclut aussi les PENDING_EMAIL du contexte LLM (sinon il peut “réenvoyer”)
    const history = (recentMsgs || [])
      .slice()
      .reverse()
      .filter((m) => !safeStr(m.content).startsWith(PENDING_EMAIL_PREFIX));

    const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });

    if (needMemoryUpdate) {
      const { data: sumMsgs, error: sumErr } = await supabaseAdmin
        .from("messages")
        .select("role, content, created_at")
        .eq("conversation_id", conversationId)
        .not("content", "like", "MEMORY:%")
        .order("created_at", { ascending: false })
        .limit(60);

      if (sumErr) return res.status(500).json({ error: "Erreur lecture messages pour résumé.", detail: sumErr.message });

      const sumHistory = (sumMsgs || [])
        .slice()
        .reverse()
        .filter((m) => !safeStr(m.content).startsWith(PENDING_EMAIL_PREFIX));

      const summarizerSystem =
        "Tu es un moteur de synthèse. Produis un résumé court et utile en français.\n" +
        "- Format : puces courtes.\n" +
        "- Faits importants, décisions, contraintes, préférences, points en attente.\n" +
        "- Max 1200 caractères.\n" +
        "- Ne pas inventer.\n";

      const summarizerUser =
        (memoryContent ? `Mémoire précédente:\n${memoryContent}\n\n` : "") +
        "Voici le fil de conversation. Mets à jour la mémoire :\n\n" +
        sumHistory.map((m) => `${m.role.toUpperCase()}: ${safeStr(m.content).slice(0, 1200)}`).join("\n");

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
    const workflowRules =
      "RÈGLES EMAIL (OBLIGATOIRES) :\n" +
      "- Tu n’envoies JAMAIS un email automatiquement.\n" +
      "- Tu dois toujours AFFICHER le brouillon (objet + contenu) et demander le destinataire si manquant.\n" +
      '- L’envoi ne peut se faire qu’après confirmation explicite de l’utilisateur : "ok envoie".\n' +
      "- Si l’utilisateur demande un mail, propose un brouillon.\n" +
      "- Si l’utilisateur demande d’envoyer, demande d’abord l’email du destinataire et la confirmation.\n" +
      "- Si tu proposes un envoi, tu peux fournir un JSON de brouillon au format :\n" +
      '{ "action":"send_email","to":"(optionnel)","cc":[],"bcc":[],"subject":"...","body_html":"<p>...</p>" }\n' +
      "- IMPORTANT : même si tu fournis ce JSON, le serveur demandera confirmation avant envoi.\n";

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

    // --- EMAIL: jamais d’envoi automatique ---
    let mailSent = false;
    let mailError = "";

    const action = extractAction(assistantText);

    if (action?.action === "send_email") {
      // On traite comme BROUILLON uniquement
      const to = safeStr(action.to).trim();
      const subject = safeStr(action.subject).trim();
      const bodyHtml = safeStr(action.body_html || action.body).trim();
      const cc = Array.isArray(action.cc) ? action.cc : [];
      const bcc = Array.isArray(action.bcc) ? action.bcc : [];

      // On accepte un brouillon même sans destinataire; mais il faut sujet+contenu
      if (!subject || !bodyHtml) {
        mailError = "Brouillon email invalide (subject/body_html).";
        assistantText =
          "Je peux rédiger le mail, mais il me manque l’objet et/ou le contenu. Donnez-moi les éléments nécessaires (contexte, ton, points à inclure) et je vous propose un brouillon.";
      } else {
        const draft = {
          action: "send_email",
          to: looksLikeEmail(to) ? to : "",
          cc,
          bcc,
          subject,
          body_html: bodyHtml,
        };

        // Stocker un brouillon en attente (system)
        await supabaseAdmin.from("messages").insert({
          conversation_id: conversationId,
          role: "system",
          content: buildPendingEmailTag(draft),
          created_at: nowIso(),
        });

        // Réponse : aperçu + demande destinataire / confirmation
        assistantText = makeDraftPreview(draft, safeStr(agent.name));
      }
    } else {
      // Si le modèle prétend "envoyé" sans action => on évite la fausse promesse
      if (/email\s+envoy/i.test(assistantText)) {
        assistantText =
          "Je peux préparer le brouillon du mail et vous demander confirmation avant envoi. Donnez-moi le contexte (destinataire, objet souhaité, ton) et je vous propose le texte.";
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
