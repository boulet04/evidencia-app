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

function normalizeText(s) {
  return safeStr(s).trim();
}

/**
 * Détection d'intention :
 * - "préparer" => brouillon
 * - "envoyer" => envoi (confirmé)
 * On favorise la sécurité : si ambigu, on ne déclenche pas l'envoi.
 */
function detectEmailIntent(userMsgRaw) {
  const t = normalizeText(userMsgRaw).toLowerCase();

  const hasPrepare =
    /\b(pr[eé]pare|r[eé]dige|brouillon|draft|compose|mets[-\s]?moi|ecris|écris)\b/i.test(t) &&
    !/\b(envoie|envoyer|envoi|valide|confirme|send)\b/i.test(t);

  const hasSend =
    /\b(envoie|envoyer|envoi|send|valide|confirme|go)\b/i.test(t) &&
    !/\b(ne\s+pas\s+envoyer|n[' ]?envoie\s+pas|sans\s+envoyer|ne\s+pas\s+l[' ]?envoyer)\b/i.test(t);

  // S'il y a "prépare" et "envoie" dans la même phrase => ambigu => on force un brouillon
  if (hasPrepare && hasSend) return "draft";
  if (hasSend) return "send";
  if (hasPrepare) return "draft";
  return "none";
}

function buildBodyHtmlFromText(text) {
  const t = safeStr(text);
  // rendu correct en HTML, conserve les retours à la ligne
  const escaped = t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div style="font-family:Arial, sans-serif; font-size:14px; line-height:1.5; white-space:pre-line">${escaped}</div>`;
}

/**
 * Extrait un JSON strict depuis une réponse LLM :
 * - accepte code fences ```json ... ```
 * - ou premier objet {...}
 */
function extractJsonObject(text) {
  const s = safeStr(text).trim();

  // 1) code fence
  const fence = s.match(/```json\s*([\s\S]*?)\s*```/i) || s.match(/```\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // ignore
    }
  }

  // 2) premier objet JSON naïf
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const chunk = s.slice(start, end + 1);
    try {
      return JSON.parse(chunk);
    } catch {
      return null;
    }
  }
  return null;
}

function isValidEmail(email) {
  const e = safeStr(email).trim();
  // validation simple
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/**
 * Choix du workflow mail depuis context.workflows (admin)
 * On privilégie provider make + name contenant mail/email/outlook
 */
function pickMailWorkflow(workflows) {
  const arr = Array.isArray(workflows) ? workflows : [];
  if (!arr.length) return null;

  const score = (w) => {
    const p = safeStr(w?.provider).toLowerCase();
    const n = safeStr(w?.name).toLowerCase();
    let s = 0;
    if (p.includes("make")) s += 10;
    if (n.includes("mail") || n.includes("email") || n.includes("outlook")) s += 10;
    if (safeStr(w?.url).startsWith("https://hook.")) s += 2;
    if (safeStr(w?.url).startsWith("https://")) s += 1;
    return s;
  };

  const sorted = [...arr].sort((a, b) => score(b) - score(a));
  const chosen = sorted[0];
  if (!chosen?.url) return null;
  return chosen;
}

async function upsertDraftEmail({ userId, agentId, context, draft }) {
  // context peut contenir sources/workflows + tout le reste. On fusionne en conservant l'existant.
  const ctx = typeof context === "object" && context ? context : {};
  const nextCtx = {
    ...ctx,
    draft_email: {
      ...draft,
      created_at: new Date().toISOString(),
    },
  };

  // upsert dans client_agent_configs
  const { error } = await supabaseAdmin
    .from("client_agent_configs")
    .upsert(
      {
        user_id: userId,
        agent_id: agentId,
        system_prompt: null, // ne change pas ici
        context: nextCtx,
      },
      { onConflict: "user_id,agent_id" }
    );

  // Note: si system_prompt existait, supabase upsert pourrait l'écraser selon config.
  // Donc on fait plutôt un update si la ligne existe.
  if (error) {
    // fallback update
    await supabaseAdmin
      .from("client_agent_configs")
      .update({ context: nextCtx })
      .eq("user_id", userId)
      .eq("agent_id", agentId);
  }

  return nextCtx;
}

async function clearDraftEmail({ userId, agentId, context }) {
  const ctx = typeof context === "object" && context ? context : {};
  const nextCtx = { ...ctx };
  delete nextCtx.draft_email;

  await supabaseAdmin
    .from("client_agent_configs")
    .update({ context: nextCtx })
    .eq("user_id", userId)
    .eq("agent_id", agentId);

  return nextCtx;
}

function formatDraftPreview(draft) {
  const to = safeStr(draft?.to).trim();
  const subject = safeStr(draft?.subject).trim();
  const body = safeStr(draft?.body).trim();

  return [
    "Brouillon prêt.",
    "",
    `To: ${to || "(à compléter)"}`,
    `Objet: ${subject || "(à compléter)"}`,
    "",
    body || "(corps vide)",
    "",
    "Si vous voulez l’envoyer, répondez : « Envoie le mail » (ou « Valide l’envoi »).",
  ].join("\n");
}

async function postToMakeWebhook(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const txt = await r.text().catch(() => "");
  if (!r.ok) {
    throw new Error(`Webhook Make HTTP ${r.status}: ${txt || "Erreur inconnue"}`);
  }
  return txt;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    if (!process.env.MISTRAL_API_KEY) {
      return res.status(500).json({ error: "MISTRAL_API_KEY manquant sur Vercel." });
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant sur Vercel." });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant sur Vercel." });
    }

    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    }
    const userId = userData.user.id;

    const { message, agentSlug } = req.body || {};
    const slug = safeStr(agentSlug).trim().toLowerCase();
    const userMsg = safeStr(message).trim();

    if (!slug) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!userMsg) return res.status(400).json({ error: "Message vide." });

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
    const context = typeof ctxObj === "object" && ctxObj ? ctxObj : {};
    const workflows = Array.isArray(context?.workflows) ? context.workflows : [];
    const draftEmail = context?.draft_email && typeof context.draft_email === "object" ? context.draft_email : null;

    const customPrompt =
      safeStr(cfg?.system_prompt).trim() ||
      safeStr(context?.prompt).trim() ||
      safeStr(context?.systemPrompt).trim() ||
      safeStr(context?.customPrompt).trim() ||
      "";

    const basePrompt =
      safeStr(agentPrompts?.[slug]?.systemPrompt).trim() ||
      `Tu es ${agent.name}${agent.description ? `, ${agent.description}` : ""}.`;

    const globalBasePrompt = await getGlobalBasePrompt();

    // Guardrails mail : l’agent ne doit produire un JSON d’envoi QUE si l’utilisateur confirme explicitement.
    const mailGuardrails = `
RÈGLES EMAIL (CRITIQUE)
- Ne JAMAIS déclencher un envoi si l’utilisateur demande seulement de "préparer", "rédiger" ou "faire un brouillon".
- Dans ce cas, tu fournis un BROUILLON lisible (texte normal) avec To / Objet / Corps, et tu demandes confirmation.
- Tu ne dois produire un JSON strict { "to": "...", "subject": "...", "body": "..." } QUE si l’utilisateur confirme explicitement l’envoi (ex: "envoie", "valide l'envoi", "envoie-le maintenant").
- Si la demande est ambiguë, tu NE PRODUIS PAS de JSON.
- Pour le corps du mail, utilise des paragraphes séparés par une ligne vide.
`;

    const finalSystemPrompt = [
      globalBasePrompt ? `INSTRUCTIONS GÉNÉRALES\n${globalBasePrompt}` : "",
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES\n${customPrompt}` : "",
      mailGuardrails,
    ]
      .filter(Boolean)
      .join("\n\n");

    const intent = detectEmailIntent(userMsg);

    /**
     * Si l’utilisateur confirme l’envoi ("send"), on veut :
     * - soit un JSON d’envoi dans la réponse LLM
     * - soit réutiliser le dernier draft stocké (context.draft_email)
     */
    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: [
        { role: "system", content: finalSystemPrompt },
        {
          role: "user",
          content:
            intent === "send"
              ? `${userMsg}\n\nIMPORTANT: Si tu envoies, réponds uniquement avec un JSON strict {to, subject, body}.`
              : userMsg,
        },
      ],
      temperature: 0.4,
    });

    const raw = completion?.choices?.[0]?.message?.content ?? "";
    const replyText = safeStr(raw).trim();

    const parsed = extractJsonObject(replyText);

    // --- CAS 1: l'utilisateur demande un brouillon (draft) ---
    if (intent === "draft") {
      // Si le modèle a quand même produit un JSON, on le traite comme un draft, jamais un envoi.
      let draft = null;

      if (parsed && typeof parsed === "object") {
        draft = {
          to: safeStr(parsed.to).trim(),
          subject: safeStr(parsed.subject).trim(),
          body: safeStr(parsed.body).trim(),
        };
      } else {
        // Sinon on laisse le texte tel quel (brouillon lisible).
        // Mais on essaie quand même d'extraire To/Objet/Corps si l'agent les a donnés.
        draft = null;
      }

      if (draft && (draft.to || draft.subject || draft.body)) {
        const payload = {
          to: draft.to,
          subject: draft.subject,
          body: draft.body,
          body_html: buildBodyHtmlFromText(draft.body),
        };
        await upsertDraftEmail({ userId, agentId: agent.id, context, draft: payload });

        return res.status(200).json({
          reply: formatDraftPreview(payload),
          mode: "draft",
          draft: payload,
        });
      }

      // Pas de JSON => on renvoie le brouillon texte tel quel
      return res.status(200).json({ reply: replyText, mode: "draft" });
    }

    // --- CAS 2: l'utilisateur demande un envoi (send) ---
    if (intent === "send") {
      // 2a) on utilise le JSON si présent, sinon on tente le dernier draft stocké.
      let payload = null;

      if (parsed && typeof parsed === "object") {
        payload = {
          to: safeStr(parsed.to).trim(),
          subject: safeStr(parsed.subject).trim(),
          body: safeStr(parsed.body).trim(),
        };
      } else if (draftEmail) {
        payload = {
          to: safeStr(draftEmail.to).trim(),
          subject: safeStr(draftEmail.subject).trim(),
          body: safeStr(draftEmail.body).trim(),
          body_html: safeStr(draftEmail.body_html).trim(),
        };
      }

      if (!payload) {
        return res.status(200).json({
          reply:
            "Je n’ai pas de brouillon à envoyer. Demandez d’abord : « Prépare un mail à … » puis confirmez : « Envoie le mail ».",
          mode: "send",
          sent: false,
        });
      }

      if (!isValidEmail(payload.to)) {
        return res.status(200).json({
          reply: `Adresse email invalide: "${payload.to}".`,
          mode: "send",
          sent: false,
        });
      }

      const wf = pickMailWorkflow(workflows);
      if (!wf?.url) {
        return res.status(200).json({
          reply:
            "Aucun workflow mail configuré dans l’admin (context.workflows). Ajoutez un workflow Make (mail) avec une URL webhook valide.",
          mode: "send",
          sent: false,
        });
      }

      // assure body_html
      const finalPayload = {
        to: payload.to,
        subject: payload.subject,
        body: payload.body,
        body_html: payload.body_html || buildBodyHtmlFromText(payload.body),
      };

      // envoi Make
      await postToMakeWebhook(wf.url, finalPayload);

      // on purge le draft stocké après envoi
      await clearDraftEmail({ userId, agentId: agent.id, context });

      return res.status(200).json({
        reply: "Email envoyé via Outlook (Make).",
        mode: "send",
        sent: true,
      });
    }

    // --- CAS 3: conversation normale (none) ---
    // Si l'agent renvoie du JSON sans demande explicite d'envoi => on force brouillon / sécurité
    if (parsed && typeof parsed === "object" && (parsed.to || parsed.subject || parsed.body)) {
      const draft = {
        to: safeStr(parsed.to).trim(),
        subject: safeStr(parsed.subject).trim(),
        body: safeStr(parsed.body).trim(),
        body_html: buildBodyHtmlFromText(safeStr(parsed.body).trim()),
      };

      await upsertDraftEmail({ userId, agentId: agent.id, context, draft });

      return res.status(200).json({
        reply: formatDraftPreview(draft),
        mode: "draft",
        draft,
      });
    }

    return res.status(200).json({ reply: replyText, mode: "none" });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
