// pages/api/chat.js
import { createClient } from "@supabase/supabase-js";
import { Mistral } from "@mistralai/mistralai";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

const MODEL = process.env.MISTRAL_MODEL || "mistral-large-latest";
const HISTORY_LIMIT = Number(process.env.CHAT_HISTORY_LIMIT || 30);

// Markers stockés dans messages.content pour retrouver le dernier brouillon
const DRAFT_OPEN = "[EMAIL_DRAFT_JSON]";
const DRAFT_CLOSE = "[/EMAIL_DRAFT_JSON]";

function extractLastEmailDraft(messages) {
  // Cherche le dernier message assistant qui contient un brouillon JSON balisé
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    const start = m.content.lastIndexOf(DRAFT_OPEN);
    const end = m.content.lastIndexOf(DRAFT_CLOSE);
    if (start === -1 || end === -1 || end <= start) continue;

    const jsonStr = m.content
      .slice(start + DRAFT_OPEN.length, end)
      .trim();

    try {
      const draft = JSON.parse(jsonStr);
      if (!draft || typeof draft !== "object") continue;
      if (!draft.to || !draft.subject || !draft.body) continue;

      return draft;
    } catch (e) {
      continue;
    }
  }
  return null;
}

function stripDraftBlock(text) {
  if (typeof text !== "string") return "";
  const start = text.lastIndexOf(DRAFT_OPEN);
  const end = text.lastIndexOf(DRAFT_CLOSE);
  if (start === -1 || end === -1 || end <= start) return text;
  // On supprime le bloc JSON balisé de l’affichage
  return (text.slice(0, start) + text.slice(end + DRAFT_CLOSE.length)).trim();
}

function isSendConfirmation(userText) {
  const t = (userText || "").trim().toLowerCase();
  // volontairement permissif
  return (
    t === "envoie" ||
    t === "envoye" ||
    t === "envoie le" ||
    t === "envoie-le" ||
    t.includes("ok envoie") ||
    t.includes("ok, envoie") ||
    t.includes("tu peux envoyer") ||
    t.includes("envoie le mail") ||
    t.includes("envoi le mail") ||
    t.includes("envoie-le par mail") ||
    t.includes("confirme") ||
    t.includes("vas-y envoie")
  );
}

function buildEmailWorkflowSystemPrompt() {
  return `
Tu es un assistant professionnel. Tu DOIS appliquer un workflow strict pour les emails.

OBJECTIF:
- Préparer un email avec : destinataire (to), objet (subject), corps (body en HTML).
- Ne JAMAIS envoyer tant que l'utilisateur ne confirme pas explicitement.

RÈGLES:
1) Si l'utilisateur demande "prépare / rédige / fais un email", tu dois COLLECTER les infos manquantes:
   - Email destinataire (obligatoire)
   - Objet (obligatoire)
   - Contenu du mail (obligatoire)
   - Signature souhaitée (optionnel)
   - Contexte (optionnel)
   Si une info obligatoire manque, pose UNE seule question courte et précise (la plus bloquante).

2) Quand tu as TOUT:
   - Tu affiches un brouillon lisible (avec paragraphes clairs).
   - Puis tu ajoutes à la FIN un bloc machine lisible EXACTEMENT sous cette forme:

${DRAFT_OPEN}
{"to":"...","subject":"...","body":"<p>...HTML...</p>"}
${DRAFT_CLOSE}

3) Tu termines en demandant confirmation:
   - "Si vous souhaitez l'envoyer, répondez : ENVOIE."

IMPORTANT:
- Le body doit être du HTML simple (<p>, <br/>, <strong>).
- Ne mets PAS d'adresse postale si l'utilisateur ne l'a pas donnée.
- Ne renvoie pas "Bonjour, comment puis-je vous aider ?" si une conversation est en cours: utilise l'historique.
`;
}

async function callMakeWebhook(payload) {
  const url = process.env.MAKE_WEBHOOK_URL;
  if (!url) {
    throw new Error("MAKE_WEBHOOK_URL manquant dans Vercel.");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    // Make peut répondre sans JSON si mal configuré
    data = { ok: res.ok, status: res.status, message: "non-json response" };
  }

  if (!res.ok) {
    const msg = data?.error || data?.message || `Make error HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Auth Bearer Supabase
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    if (!token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(
      token
    );
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }
    const user = userData.user;

    const {
      conversationId: conversationIdRaw,
      agentSlug: agentSlugRaw,
      message: userMessageRaw,
    } = req.body || {};

    const userMessage = (userMessageRaw || "").toString().trim();
    if (!userMessage) {
      return res.status(400).json({ error: "Message vide" });
    }

    let conversationId = conversationIdRaw || null;
    let agentSlug = agentSlugRaw || null;

    // 1) Charger ou créer la conversation
    if (conversationId) {
      const { data: conv, error: convErr } = await supabaseAdmin
        .from("conversations")
        .select("id, user_id, agent_slug, title, archived")
        .eq("id", conversationId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (convErr || !conv) {
        return res.status(404).json({ error: "Conversation introuvable" });
      }

      // Si le front n'envoie pas agentSlug, on le récupère de la conversation
      agentSlug = agentSlug || conv.agent_slug || null;
    } else {
      if (!agentSlug) {
        return res.status(400).json({ error: "Aucun agent sélectionné." });
      }

      const title = userMessage.length > 60 ? userMessage.slice(0, 60) + "…" : userMessage;

      const { data: newConv, error: newConvErr } = await supabaseAdmin
        .from("conversations")
        .insert({
          user_id: user.id,
          agent_slug: agentSlug,
          title,
          archived: false,
        })
        .select("id")
        .single();

      if (newConvErr || !newConv) {
        return res.status(500).json({ error: "Impossible de créer la conversation" });
      }
      conversationId = newConv.id;
    }

    if (!agentSlug) {
      return res.status(400).json({ error: "Aucun agent sélectionné." });
    }

    // 2) Charger l'historique messages
    const { data: history, error: histErr } = await supabaseAdmin
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(HISTORY_LIMIT);

    if (histErr) {
      return res.status(500).json({ error: "Erreur chargement historique" });
    }

    // 3) Si confirmation ENVOIE -> on envoie via Make à partir du dernier brouillon
    if (isSendConfirmation(userMessage)) {
      const draft = extractLastEmailDraft(history || []);
      if (!draft) {
        // Pas de brouillon => on répond sans casser la conversation
        const reply = "Je n’ai pas de brouillon d’email à envoyer dans cette conversation. Dites-moi : destinataire, objet et contenu, et je le prépare.";
        await supabaseAdmin.from("messages").insert([
          { conversation_id: conversationId, role: "user", content: userMessage },
          { conversation_id: conversationId, role: "assistant", content: reply },
        ]);
        return res.status(200).json({ conversationId, reply });
      }

      // Validation minimale avant Make (Make refusera sinon)
      const payload = {
        to: String(draft.to).trim(),
        subject: String(draft.subject).trim(),
        body: String(draft.body),
      };

      if (!payload.to || !payload.subject || !payload.body) {
        const reply =
          "Je ne peux pas envoyer : il manque l’adresse email, l’objet ou le contenu. Je peux refaire le brouillon proprement si vous me confirmez ces éléments.";
        await supabaseAdmin.from("messages").insert([
          { conversation_id: conversationId, role: "user", content: userMessage },
          { conversation_id: conversationId, role: "assistant", content: reply },
        ]);
        return res.status(200).json({ conversationId, reply });
      }

      // Insert user message
      await supabaseAdmin.from("messages").insert([
        { conversation_id: conversationId, role: "user", content: userMessage },
      ]);

      try {
        const makeResult = await callMakeWebhook(payload);

        const reply =
          `Email envoyé ✓\n\nDétails Make : ${JSON.stringify(makeResult)}`;

        await supabaseAdmin.from("messages").insert([
          { conversation_id: conversationId, role: "assistant", content: reply },
        ]);

        return res.status(200).json({
          conversationId,
          reply,
          sent: true,
          make: makeResult,
        });
      } catch (e) {
        const reply =
          `Échec de l’envoi (Make).\n\nErreur : ${e.message}`;

        await supabaseAdmin.from("messages").insert([
          { conversation_id: conversationId, role: "assistant", content: reply },
        ]);

        return res.status(200).json({
          conversationId,
          reply,
          sent: false,
          make_error: e.message,
        });
      }
    }

    // 4) Sinon : appel LLM (avec historique + prompt agent)
    // Charger agent prompt personnalisé si présent
    const { data: cfg } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", user.id)
      .maybeSingle();

    const customSystem = cfg?.system_prompt ? String(cfg.system_prompt) : "";
    const emailWorkflow = buildEmailWorkflowSystemPrompt();

    // Préparer messages pour Mistral
    const mistralMessages = [];

    // system global
    mistralMessages.push({
      role: "system",
      content: [customSystem, emailWorkflow].filter(Boolean).join("\n\n"),
    });

    // historique
    for (const m of history || []) {
      if (!m?.role || !m?.content) continue;
      mistralMessages.push({
        role: m.role,
        content: String(m.content),
      });
    }

    // nouveau message user
    mistralMessages.push({
      role: "user",
      content: userMessage,
    });

    // Enregistrer le user message en base
    await supabaseAdmin.from("messages").insert([
      { conversation_id: conversationId, role: "user", content: userMessage },
    ]);

    const completion = await mistral.chat.complete({
      model: MODEL,
      messages: mistralMessages,
      temperature: 0.4,
    });

    const assistantText =
      completion?.choices?.[0]?.message?.content?.toString?.() ||
      completion?.choices?.[0]?.message?.content ||
      "";

    const cleanReply = stripDraftBlock(String(assistantText));

    // Sauver réponse assistant (on conserve les markers si présents)
    await supabaseAdmin.from("messages").insert([
      { conversation_id: conversationId, role: "assistant", content: String(assistantText) },
    ]);

    return res.status(200).json({
      conversationId,
      reply: cleanReply,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
