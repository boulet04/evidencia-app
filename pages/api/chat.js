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

function looksLikeHtml(s) {
  const t = safeStr(s).trim();
  return /<\/?(p|br|div|span|strong|em|ul|ol|li|table|tr|td|h1|h2|h3|html|body)\b/i.test(t);
}

function plainToHtml(plain) {
  const t = safeStr(plain).trim();
  if (!t) return "";
  // Split on blank lines => paragraphs
  const parts = t.split(/\n\s*\n+/g).map((p) => p.trim()).filter(Boolean);
  const escaped = parts.map((p) =>
    p
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br/>")
  );
  return escaped.map((p) => `<p>${p}</p>`).join("");
}

function isJsonOnly(str) {
  const t = safeStr(str).trim();
  if (!t) return false;
  if (!(t.startsWith("{") && t.endsWith("}"))) return false;
  try {
    const obj = JSON.parse(t);
    return obj && typeof obj === "object" && !Array.isArray(obj);
  } catch {
    return false;
  }
}

function detectSendIntent(userMsg) {
  const t = safeStr(userMsg).toLowerCase();
  // Intention forte d'envoi
  return (
    /\b(envoie|envoyer|envoi|expédie|expedie|envoie\s+le\s+mail|envoie\s+un\s+mail)\b/.test(t) &&
    !/\b(ne\s+pas\s+envoyer|n[' ]?envoie\s+pas|sans\s+envoyer|prépare\s+sans\s+envoyer)\b/.test(t)
  );
}

function getMakeWebhookUrl(ctxObj) {
  // On supporte plusieurs clés pour s’adapter à ton UI / workflows
  const candidates = [
    ctxObj?.make_webhook_url,
    ctxObj?.makeWebhookUrl,
    ctxObj?.make?.webhookUrl,
    ctxObj?.make?.url,
    ctxObj?.workflows?.make?.webhookUrl,
    ctxObj?.workflows?.make?.url,
    ctxObj?.workflow?.make?.url,
    ctxObj?.workflow_url,
  ]
    .map((x) => safeStr(x).trim())
    .filter(Boolean);

  const fromEnv = safeStr(process.env.MAKE_WEBHOOK_URL).trim();
  if (fromEnv) candidates.push(fromEnv);

  // On prend le premier qui ressemble à une URL Make
  const url = candidates.find((u) => /^https:\/\/hook\.[a-z0-9-]+\.make\.com\/.+/i.test(u)) || candidates[0] || "";
  return url;
}

async function postToMake(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await r.text().catch(() => "");
    if (!r.ok) {
      throw new Error(`Make HTTP ${r.status} ${r.statusText} ${text ? `- ${text}` : ""}`.trim());
    }
    return { ok: true, status: r.status, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadConversationHistory(conversationId, userId, limit = 20) {
  if (!conversationId) return { conv: null, history: [] };

  // Vérifier appartenance conversation
  const { data: conv, error: convErr } = await supabaseAdmin
    .from("conversations")
    .select("id, user_id, agent_slug, title, archived, created_at")
    .eq("id", conversationId)
    .maybeSingle();

  if (convErr || !conv) return { conv: null, history: [] };
  if (conv.user_id !== userId) return { conv: null, history: [] };

  const { data: msgs, error: msgErr } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(Math.max(limit, 1));

  if (msgErr || !Array.isArray(msgs)) return { conv, history: [] };

  const history = msgs
    .map((m) => ({
      role: safeStr(m.role).toLowerCase(),
      content: safeStr(m.content),
    }))
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-limit);

  return { conv, history };
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
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    const userId = userData.user.id;

    const { message, agentSlug, conversationId } = req.body || {};
    const userMsg = safeStr(message).trim();
    if (!userMsg) return res.status(400).json({ error: "Message vide." });

    // Agent slug: priorités -> body.agentSlug, sinon conversation.agent_slug (si conversationId fourni)
    const { conv, history } = await loadConversationHistory(conversationId, userId, 20);
    const slug = safeStr(agentSlug || conv?.agent_slug).trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: "Aucun agent sélectionné." });

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

    // IMPORTANT : on renforce côté serveur la règle "préparer vs envoyer"
    // - si l'utilisateur veut PREPARER: l'agent doit rendre un brouillon lisible (pas de JSON)
    // - si l'utilisateur veut ENVOYER: l'agent doit rendre un JSON strict {to, subject, body} (body en HTML)
    const serverSafety = `
RÈGLES OUTILS EMAIL (Make/Outlook) - À RESPECTER STRICTEMENT
- Si l'utilisateur demande de PRÉPARER / RÉDIGER / PROPOSER un email SANS demander explicitement l'envoi: tu fournis un brouillon humain lisible (avec paragraphes), PAS de JSON.
- Tu n'envoies JAMAIS un email sans confirmation explicite.
- Si (et seulement si) l'utilisateur demande explicitement l'ENVOI (ex: "envoie", "envoyer le mail"): tu réponds UNIQUEMENT par un JSON STRICT, sans texte autour, avec exactement:
  { "to": "<email>", "subject": "<objet>", "body": "<HTML>" }
- Le champ body doit être un HTML simple (<p>..., <br/>) pour que l'email soit bien formaté.
`;

    const finalSystemPrompt = [
      globalBasePrompt ? `INSTRUCTIONS GÉNÉRALES\n${globalBasePrompt}` : "",
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES\n${customPrompt}` : "",
      serverSafety,
    ]
      .filter(Boolean)
      .join("\n\n");

    const messages = [{ role: "system", content: finalSystemPrompt }];

    // Historique conversation (si dispo)
    for (const m of history) {
      messages.push({ role: m.role, content: m.content });
    }

    // Message actuel
    messages.push({ role: "user", content: userMsg });

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages,
      temperature: 0.7,
    });

    const rawReply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";

    // Si le modèle renvoie du JSON, on décide si on déclenche Make ou non
    if (isJsonOnly(rawReply)) {
      const obj = JSON.parse(rawReply);
      const to = safeStr(obj?.to).trim();
      const subject = safeStr(obj?.subject).trim();
      let body = safeStr(obj?.body).trim();

      // On ne déclenche l'envoi que si l'utilisateur a vraiment demandé l'envoi
      const sendIntent = detectSendIntent(userMsg);

      // Validation minimale
      if (!to || !subject || !body) {
        // On renvoie un message humain plutôt que planter
        return res.status(200).json({
          reply:
            "Le brouillon est incomplet (to/subject/body). Reformulez la demande ou précisez le destinataire, l’objet et le contenu.",
        });
      }

      // Body en HTML
      if (!looksLikeHtml(body)) body = plainToHtml(body);

      if (!sendIntent) {
        // Cas : le modèle a quand même renvoyé du JSON alors que l'utilisateur demandait juste de préparer
        // => on renvoie un brouillon lisible et on n'envoie rien
        const preview =
          `Brouillon prêt (non envoyé). Dites "envoie" pour l’envoyer.\n\n` +
          `Destinataire : ${to}\n` +
          `Objet : ${subject}\n\n` +
          body.replace(/<\/?p>/g, "").replace(/<br\/>/g, "\n").trim();

        return res.status(200).json({ reply: preview });
      }

      // Envoi via Make
      const makeUrl = getMakeWebhookUrl(ctxObj || {});
      if (!makeUrl) {
        return res.status(500).json({
          error:
            "Aucune URL Make webhook configurée. Ajoutez-la dans le workflow (ou set MAKE_WEBHOOK_URL sur Vercel).",
        });
      }

      try {
        await postToMake(makeUrl, { to, subject, body });
        return res.status(200).json({ reply: "Email envoyé via Outlook (Make)." });
      } catch (e) {
        console.error("Erreur Make:", e);
        return res.status(502).json({
          error: `Échec d’envoi via Make. Vérifiez que le scénario est ON et que l’URL webhook est correcte. Détail: ${safeStr(e?.message)}`,
        });
      }
    }

    // Sinon, réponse standard
    return res.status(200).json({ reply: rawReply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
