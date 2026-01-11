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
  const t = safeStr(text).trim().toUpperCase();
  // tolérant : ENVOIE / ENVOYER / ENVOIE LE MAIL / ENVOIE STP etc.
  return /^ENVOI(E|ER)\b/.test(t);
}

function extractFirstJsonObject(text) {
  const raw = safeStr(text).trim();
  if (!raw) return null;

  // 1) bloc ```json ... ```
  const m = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  if (m && m[1]) {
    try {
      return JSON.parse(m[1]);
    } catch {
      // continue
    }
  }

  // 2) tentative directe si ça commence par "{"
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      return JSON.parse(raw);
    } catch {
      // continue
    }
  }

  // 3) fallback : prendre la première { ... } “raisonnable”
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

function pickAgentSlug(reqBody, reqQuery) {
  // compat : plusieurs noms possibles selon tes versions de front
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

function getMakeWebhookUrl(ctxObj) {
  // Recommandé : ctxObj.make_webhook_url
  // Tolérant : variantes possibles
  const direct =
    safeStr(ctxObj?.make_webhook_url).trim() ||
    safeStr(ctxObj?.makeWebhookUrl).trim() ||
    safeStr(ctxObj?.make_webhook).trim() ||
    safeStr(ctxObj?.webhook_url).trim() ||
    safeStr(ctxObj?.workflow_url).trim();

  const nested =
    safeStr(ctxObj?.make?.webhook_url).trim() ||
    safeStr(ctxObj?.make?.webhookUrl).trim();

  const url = direct || nested;
  return url || "";
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
    if (!r.ok) {
      return { ok: false, status: r.status, body: txt };
    }
    return { ok: true, status: r.status, body: txt };
  } catch (e) {
    return { ok: false, status: 0, body: safeStr(e?.message || e) };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadConversationHistory(conversationId, limit = 20) {
  if (!conversationId) return [];

  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !Array.isArray(data)) return [];
  // roles attendus: user / assistant / system
  return data
    .map((m) => ({
      role: safeStr(m.role).trim() || "user",
      content: safeStr(m.content),
    }))
    .filter((m) => m.content.trim().length > 0);
}

async function loadLastAssistantMessage(conversationId) {
  if (!conversationId) return "";

  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return "";
  return safeStr(data?.content);
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

    const token = getBearerToken(req);
    if (!token) {
      // 200 pour éviter l’alerte front si tu gères mal les non-200
      return res.status(200).json({ reply: "Non authentifié (token manquant)." });
    }

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(200).json({ reply: "Session invalide. Reconnectez-vous." });
    }
    const userId = userData.user.id;

    const reqBody = req.body || {};
    const userMsg = safeStr(reqBody.message).trim();
    const conversationId = safeStr(reqBody.conversationId).trim();
    const slug = pickAgentSlug(reqBody, req.query);

    if (!slug) {
      return res.status(200).json({ reply: "Aucun agent sélectionné." });
    }
    if (!userMsg) {
      return res.status(200).json({ reply: "Message vide." });
    }

    // Agent
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (agentErr || !agent) {
      return res.status(200).json({ reply: "Agent introuvable." });
    }

    // Vérif assignation
    const { data: assignment, error: assignErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (assignErr) return res.status(500).json({ error: "Erreur assignation (user_agents)." });
    if (!assignment) return res.status(200).json({ reply: "Accès interdit : agent non assigné." });

    // Config user-agent
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

    // IMPORTANT : règle ferme d’envoi email = 2 temps
    const hardEmailRule = `
RÈGLE EMAIL (INTÉGRATION MAKE)
- Tu peux préparer des emails (brouillon), mais TU N’ENVOIES JAMAIS tant que l’utilisateur n’a pas écrit exactement: "ENVOIE" ou "ENVOYER".
- Quand on te demande de "préparer" ou "rédiger" un email: tu fournis (1) un brouillon lisible, puis (2) un bloc JSON strict dans un bloc \`\`\`json\`\`\` avec exactement: { "to": "...", "subject": "...", "body": "..." }.
- "body" doit être du HTML simple (paragraphes <p>, listes <ul><li>, sauts <br/> si besoin).
- Si le destinataire manque, mets "to": "" et demande le destinataire.
`;

    const finalSystemPrompt = [
      globalBasePrompt
        ? `INSTRUCTIONS GÉNÉRALES (communes à tous les agents)\n${globalBasePrompt}`
        : "",
      hardEmailRule.trim(),
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR :\n${customPrompt}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    // ------------- MODE "ENVOIE" : on envoie via Make sans repasser par le LLM -------------
    if (isSendConfirmation(userMsg)) {
      // Il faut un conversationId pour retrouver le dernier brouillon JSON
      if (!conversationId) {
        return res.status(200).json({
          reply:
            "Je ne peux pas envoyer car je n’ai pas l’identifiant de conversation. Recharge la page et réessaie, ou renvoie le brouillon.",
        });
      }

      const makeUrl = getMakeWebhookUrl(ctxObj || {});
      if (!makeUrl) {
        return res.status(200).json({
          reply:
            "Aucun webhook Make configuré pour cet agent/utilisateur. Ajoute-le dans le contexte (clé recommandée: make_webhook_url).",
        });
      }

      const lastAssistant = await loadLastAssistantMessage(conversationId);
      const jsonObj = extractFirstJsonObject(lastAssistant);
      const payload = normalizeEmailPayload(jsonObj);

      if (!payload) {
        return res.status(200).json({
          reply:
            "Je ne trouve pas de brouillon JSON valide dans le dernier message assistant. Demande d’abord: “Prépare un email à …”, puis écris ENVOIE.",
        });
      }

      const send = await postToMakeWebhook(makeUrl, payload);
      if (!send.ok) {
        return res.status(200).json({
          reply: `Échec d’envoi via Make (HTTP ${send.status}). Vérifie le scénario Make et le mapping. Détail: ${send.body || "—"}`,
        });
      }

      return res.status(200).json({ reply: "Email envoyé via Outlook (Make)." });
    }

    // ------------- MODE NORMAL : conversation + mémoire -------------
    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

    const history = await loadConversationHistory(conversationId, 24);

    const messages = [
      { role: "system", content: finalSystemPrompt },
      ...history.filter((m) => m.role === "user" || m.role === "assistant"),
      { role: "user", content: userMsg },
    ];

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
