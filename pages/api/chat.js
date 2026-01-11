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

// Confirmation stricte (pour éviter les envois accidentels)
function isExplicitSendConfirmation(text) {
  const t = safeStr(text).trim().toLowerCase();

  // Si l’utilisateur dit "n'envoie pas", on bloque toujours
  const hasNegation =
    t.includes("n'envoie pas") ||
    t.includes("n’envoie pas") ||
    t.includes("ne l'envoie pas") ||
    t.includes("ne l’envoie pas") ||
    t.includes("ne pas envoyer") ||
    t.includes("pas envoyer") ||
    t.includes("sans envoyer");

  if (hasNegation) return false;

  // Confirmation volontairement stricte
  const ok =
    t === "envoie" ||
    t === "envoie le mail" ||
    t === "envoie l'email" ||
    t === "envoie l’email" ||
    t === "envoie le courrier" ||
    t === "confirme envoi" ||
    t === "ok envoie" ||
    t === "vas-y envoie";

  return ok;
}

function looksLikeActionJson(reply) {
  const s = safeStr(reply).trim();
  return s.startsWith("{") && s.endsWith("}");
}

function tryParseActionJson(reply) {
  const s = safeStr(reply).trim();
  try {
    const obj = JSON.parse(s);
    if (!obj || typeof obj !== "object") return null;

    const to = safeStr(obj.to).trim();
    const subject = safeStr(obj.subject).trim();
    const body = safeStr(obj.body).trim();

    if (!to || !subject || !body) return null;
    return { to, subject, body };
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  return safeStr(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function textToBasicHtml(text) {
  // Convertit un texte en HTML lisible (paragraphes)
  const lines = safeStr(text).split(/\r?\n/);

  // Regroupe en paragraphes (séparés par ligne vide)
  const paragraphs = [];
  let buf = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (buf.length) {
        paragraphs.push(buf.join(" ").trim());
        buf = [];
      }
    } else {
      buf.push(line.trim());
    }
  }
  if (buf.length) paragraphs.push(buf.join(" ").trim());

  const html = paragraphs
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");

  return html || `<p>${escapeHtml(safeStr(text).trim())}</p>`;
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

  // On ne garde que user/assistant, on force string
  return data
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: safeStr(m.content),
    }))
    .filter((m) => m.content.trim().length > 0);
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

    const body = req.body || {};
    const userMsg = safeStr(body.message).trim();

    // IMPORTANT: accepter plusieurs noms de champs pour le slug
    const rawSlug =
      body.agentSlug ??
      body.agent ??
      body.slug ??
      body.agent_slug ??
      "";

    const slug = safeStr(rawSlug).trim().toLowerCase();

    // IMPORTANT: accepter plusieurs noms de champs pour conversationId
    const conversationId = safeStr(body.conversationId ?? body.conversation_id ?? "").trim();

    if (!slug) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!userMsg) return res.status(400).json({ error: "Message vide." });

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

    // Config perso
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

    // Règles “actions” (Make) — on force une convention robuste
    const actionRules = `
RÈGLES IMPORTANTES (EMAIL VIA MAKE / OUTLOOK)

1) Deux étapes obligatoires :
- Étape A (préparation) : tu rédiges un BROUILLON lisible (pas de JSON), avec sections :
  Destinataire:
  Objet:
  Corps:
  (corps avec paragraphes séparés par une ligne vide)
  Puis tu demandes explicitement une confirmation : "Si vous voulez l'envoyer, répondez : ENVOIE"

- Étape B (envoi) : uniquement si l'utilisateur répond EXACTEMENT "ENVOIE" / "ENVOIE LE MAIL" / "CONFIRME ENVOI".
  Dans ce cas seulement, tu réponds avec un JSON STRICT (aucun texte autour) :
  {"to":"...","subject":"...","body":"<p>...</p>"}
  body doit être en HTML (paragraphes <p>), sinon Outlook colle tout sur une ligne.

2) Interdiction d'envoyer si l'utilisateur demande seulement "prépare", "rédige", "brouillon", "sans envoyer".
3) Si tu n'as pas les infos (destinataire / sujet / contenu), tu poses UNE seule question courte.
`.trim();

    const finalSystemPrompt = [
      globalBasePrompt
        ? `INSTRUCTIONS GÉNÉRALES (communes à tous les agents)\n${globalBasePrompt}`
        : "",
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR :\n${customPrompt}` : "",
      actionRules,
    ]
      .filter(Boolean)
      .join("\n\n");

    // Mémoire conversation
    const history = await loadConversationHistory(conversationId, 20);

    // IMPORTANT: éviter de dupliquer le dernier message user si le front l’a déjà inséré en base avant l’appel API.
    // On supprime le dernier élément si c’est exactement le même user message.
    const normalizedUserMsg = userMsg.trim();
    const historyTrimmed = [...history];
    const last = historyTrimmed[historyTrimmed.length - 1];
    if (last?.role === "user" && safeStr(last.content).trim() === normalizedUserMsg) {
      historyTrimmed.pop();
    }

    const messagesForModel = [
      { role: "system", content: finalSystemPrompt },
      ...historyTrimmed.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMsg },
    ];

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: messagesForModel,
      temperature: 0.7,
    });

    let reply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";

    // Garde-fou anti-envoi accidentel :
    // Si le modèle renvoie un JSON action mais que l’utilisateur n’a pas confirmé, on bloque.
    if (looksLikeActionJson(reply)) {
      const action = tryParseActionJson(reply);
      if (action) {
        const allowed = isExplicitSendConfirmation(userMsg);

        if (!allowed) {
          // On remplace le JSON par un brouillon lisible (donc Make ne sera pas déclenché)
          const bodyAsText = action.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          reply =
            `Voici le brouillon (NON envoyé) :\n\n` +
            `Destinataire: ${action.to}\n` +
            `Objet: ${action.subject}\n\n` +
            `Corps:\n${bodyAsText}\n\n` +
            `Si vous voulez l'envoyer, répondez : ENVOIE`;
        } else {
          // On force body en HTML si jamais c’est du texte brut
          const seemsHtml = /<\/(p|br|div|span|table|html|body)>/i.test(action.body) || /<p[ >]/i.test(action.body);
          const safeBodyHtml = seemsHtml ? action.body : textToBasicHtml(action.body);

          reply = JSON.stringify(
            { to: action.to, subject: action.subject, body: safeBodyHtml },
            null,
            0
          );
        }
      }
    }

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
