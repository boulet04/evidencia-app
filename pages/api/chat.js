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

// --- Make helpers ---

function isExplicitSendConfirmation(userMsg) {
  // Tu peux ajuster les mots-clés si besoin
  return /CONFIRME\s+ENVOI|ENVOIE\s+MAINTENANT|CONFIRMER\s+L'?ENVOI/i.test(userMsg || "");
}

function tryParseStrictJsonObject(text) {
  // On tente de parser un JSON "pur" (pas de texte autour)
  const t = safeStr(text).trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  try {
    const obj = JSON.parse(t);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function pickMakeWebhookForEmail(workflows) {
  // workflows attendus: [{provider, name, url}]
  const list = Array.isArray(workflows) ? workflows : [];
  const makeOnes = list.filter(
    (w) => safeStr(w?.provider).toLowerCase() === "make" && /^https?:\/\//i.test(safeStr(w?.url))
  );

  if (makeOnes.length === 0) return null;

  // 1) Priorité si le nom contient mail/email
  const preferred = makeOnes.find((w) => /mail|email/i.test(safeStr(w?.name)));
  return preferred?.url || makeOnes[0].url;
}

async function postJsonWithTimeout(url, payload, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await r.text().catch(() => "");
    if (!r.ok) {
      return { ok: false, status: r.status, body: text };
    }
    return { ok: true, status: r.status, body: text };
  } finally {
    clearTimeout(timer);
  }
}

function formatDraftEmail(to, subject, body) {
  // Affichage simple côté chat (tu peux améliorer ensuite côté UI)
  const t = safeStr(to).trim() || "(destinataire manquant)";
  const s = safeStr(subject).trim() || "(objet manquant)";
  const b = safeStr(body).trim() || "(corps manquant)";

  return [
    "Brouillon d’email (non envoyé) :",
    "",
    `To: ${t}`,
    `Subject: ${s}`,
    "",
    b,
    "",
    "Si c’est OK, réponds exactement : CONFIRME ENVOI",
  ].join("\n");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }

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
    if (!token) {
      return res.status(401).json({ error: "Non authentifié (token manquant)." });
    }

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

    if (agentErr || !agent) {
      return res.status(404).json({ error: "Agent introuvable." });
    }

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

    const customPrompt =
      safeStr(cfg?.system_prompt).trim() ||
      safeStr(ctxObj?.prompt).trim() ||
      safeStr(ctxObj?.systemPrompt).trim() ||
      safeStr(ctxObj?.customPrompt).trim() ||
      "";

    const basePrompt =
      safeStr(agentPrompts?.[slug]?.systemPrompt).trim() ||
      `Tu es ${agent.name}${agent.description ? `, ${agent.description}` : ""}.`;

    const globalBasePrompt = await getGlobalBasePrompt();

    // Bloc "outil" durci côté backend : action draft/send + JSON strict
    const toolProtocol = [
      "PROTOCOLE OUTILS (STRICT) — À RESPECTER ABSOLUMENT",
      "Si tu dois produire un email via Make, tu DOIS répondre uniquement avec un JSON strict (aucun texte autour) avec ces clés :",
      '{ "action": "draft" | "send", "to": "email", "subject": "string", "body": "string" }',
      "Règles :",
      '- Si l’utilisateur demande de "préparer"/"rédiger"/"proposer" : action = "draft" (NE PAS ENVOYER).',
      '- Tu n’utilises action = "send" QUE si l’utilisateur a explicitement confirmé avec : "CONFIRME ENVOI" ou "ENVOIE MAINTENANT".',
      "Sinon, reste en draft.",
      "",
      "Important : si tu n’es pas certain du destinataire ou de l’objet, tu restes en draft et tu demandes 1 question courte.",
    ].join("\n");

    const finalSystemPrompt = [
      globalBasePrompt
        ? `INSTRUCTIONS GÉNÉRALES (communes à tous les agents)\n${globalBasePrompt}`
        : "",
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR :\n${customPrompt}` : "",
      toolProtocol,
    ]
      .filter(Boolean)
      .join("\n\n");

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: [
        { role: "system", content: finalSystemPrompt },
        { role: "user", content: userMsg },
      ],
      temperature: 0.7,
    });

    const rawReply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";

    // 1) Détection JSON strict pour email
    const obj = tryParseStrictJsonObject(rawReply);
    const action = safeStr(obj?.action).toLowerCase();
    const to = safeStr(obj?.to).trim();
    const subject = safeStr(obj?.subject).trim();
    const body = safeStr(obj?.body).trim();

    const looksLikeEmailToolCall =
      obj &&
      ["draft", "send"].includes(action) &&
      ("to" in obj || "subject" in obj || "body" in obj);

    if (!looksLikeEmailToolCall) {
      // Pas un appel outil : on renvoie la réponse normale de l’agent
      return res.status(200).json({ reply: rawReply });
    }

    // 2) Sélection du webhook Make (email) dans context.workflows
    const workflows = Array.isArray(ctxObj?.workflows) ? ctxObj.workflows : [];
    const webhookUrl = pickMakeWebhookForEmail(workflows);

    // 3) Sécurité : si pas de webhook → on renvoie un draft, jamais d’envoi
    if (!webhookUrl) {
      const draft = formatDraftEmail(to, subject, body);
      return res.status(200).json({
        reply:
          draft +
          "\n\n(Workflow Make introuvable : ajoute un workflow provider=make dont le nom contient mail/email, avec une URL https.)",
        meta: { tool: "email", action: "draft", blocked: true, reason: "missing_webhook" },
      });
    }

    // 4) Blocage serveur : pas de send sans confirmation utilisateur explicite
    const hasUserConfirm = isExplicitSendConfirmation(userMsg);

    if (action !== "send" || !hasUserConfirm) {
      const draft = formatDraftEmail(to, subject, body);
      return res.status(200).json({
        reply: draft,
        meta: { tool: "email", action: "draft", blocked: action === "send" && !hasUserConfirm },
      });
    }

    // 5) SEND : on appelle Make uniquement ici
    // Payload attendu côté Make: {to, subject, body}
    const payload = { to, subject, body };

    const result = await postJsonWithTimeout(webhookUrl, payload, 15000);
    if (!result.ok) {
      // En cas d’échec Make : on renvoie le draft + erreur, sans retry automatique
      const draft = formatDraftEmail(to, subject, body);
      return res.status(200).json({
        reply:
          draft +
          `\n\n(Erreur Make: HTTP ${result.status}. Vérifie le scénario / mapping Outlook.)`,
        meta: { tool: "email", action: "send", ok: false, status: result.status },
      });
    }

    return res.status(200).json({
      reply: "Email envoyé via Outlook (Make).",
      meta: { tool: "email", action: "send", ok: true, status: result.status },
    });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
