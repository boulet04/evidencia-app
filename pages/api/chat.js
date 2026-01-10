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

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractJsonCommand(text) {
  const t = safeStr(text).trim();
  if (!t) return null;

  // Supporte bloc ```json ... ```
  const fenced = t.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return safeJsonParse(fenced[1].trim());
  }

  // Supporte JSON brut
  if (t.startsWith("{") && t.endsWith("}")) {
    return safeJsonParse(t);
  }

  return null;
}

function pickMakeWorkflowUrl(workflows, kind) {
  const list = Array.isArray(workflows) ? workflows : [];
  const makeList = list.filter(
    (w) =>
      safeStr(w?.provider).toLowerCase() === "make" &&
      /^https?:\/\//i.test(safeStr(w?.url))
  );

  if (makeList.length === 0) return null;

  if (kind === "send_email") {
    return (
      makeList.find((w) => /mail|email/i.test(safeStr(w?.name)))?.url ||
      makeList[0].url
    );
  }

  if (kind === "create_event") {
    return (
      makeList.find((w) =>
        /agenda|calendar|calendrier|rdv|rendez/i.test(safeStr(w?.name))
      )?.url || makeList[0].url
    );
  }

  return makeList[0].url;
}

async function postToMake(url, payload) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw new Error(`Make webhook error (${resp.status}): ${text?.slice(0, 300)}`);
  }
  return text;
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

    // Compat : supporte agentSlug OU agent_slug
    const body = req.body || {};
    const message = safeStr(body.message).trim();
    const agentSlugRaw = safeStr(body.agentSlug || body.agent_slug).trim().toLowerCase();
    const conversationId = safeStr(body.conversation_id || body.conversationId).trim();

    if (!agentSlugRaw) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!message) return res.status(400).json({ error: "Message vide." });
    if (!conversationId) return res.status(400).json({ error: "conversation_id manquant." });

    // Vérifie que la conversation appartient à l'utilisateur
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id,user_id,agent_slug")
      .eq("id", conversationId)
      .maybeSingle();

    if (convErr || !conv) {
      return res.status(404).json({ error: "Conversation introuvable." });
    }
    if (safeStr(conv.user_id) !== userId) {
      return res.status(403).json({ error: "Accès interdit : conversation non autorisée." });
    }

    // Optionnel : cohérence agent
    if (safeStr(conv.agent_slug).trim() && safeStr(conv.agent_slug).trim() !== agentSlugRaw) {
      // On ne bloque pas forcément, mais c'est plus sain de bloquer :
      return res.status(400).json({ error: "Agent incohérent avec la conversation." });
    }

    // Agent
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", agentSlugRaw)
      .maybeSingle();

    if (agentErr || !agent) {
      return res.status(404).json({ error: "Agent introuvable." });
    }

    // Vérifie assignation user_agents
    const { data: assignment, error: assignErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (assignErr) return res.status(500).json({ error: "Erreur assignation (user_agents)." });
    if (!assignment) return res.status(403).json({ error: "Accès interdit : agent non assigné." });

    // Config perso agent (prompt + context)
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

    const workflows = Array.isArray(ctxObj?.workflows) ? ctxObj.workflows : [];
    const sources = Array.isArray(ctxObj?.sources) ? ctxObj.sources : [];

    const basePrompt =
      safeStr(agentPrompts?.[agentSlugRaw]?.systemPrompt).trim() ||
      `Tu es ${agent.name}${agent.description ? `, ${agent.description}` : ""}.`;

    const globalBasePrompt = await getGlobalBasePrompt();

    const workflowsListText = workflows
      .map((w) => `- provider=${safeStr(w?.provider)} name=${safeStr(w?.name)} url=${safeStr(w?.url) ? "[set]" : "[missing]"}`)
      .join("\n");

    const sourcesListText = sources
      .slice(0, 20)
      .map((s) => {
        const t = safeStr(s?.type);
        const name = safeStr(s?.name || s?.url || s?.path);
        return `- ${t || "source"}: ${name}`;
      })
      .join("\n");

    const actionPolicy = `
Tu peux exécuter des actions via des workflows Make configurés.

WORKFLOWS DISPONIBLES (Make) :
${workflowsListText || "- (aucun)"}

SOURCES (si besoin pour répondre) :
${sourcesListText || "- (aucune)"}

RÈGLES D'ACTION :
- Si l'utilisateur demande d'envoyer un email, réponds UNIQUEMENT par un JSON (sans texte autour) :
{"action":"send_email","to":"email@domaine.fr","subject":"Sujet","text":"Contenu"}

- Si l'utilisateur demande de créer un rendez-vous / évènement agenda, réponds UNIQUEMENT par un JSON :
{"action":"create_event","title":"Titre","start":"YYYY-MM-DDTHH:mm:ss","end":"YYYY-MM-DDTHH:mm:ss","notes":"optionnel"}

Si un champ est manquant, pose une question au lieu d'inventer.
`;

    const finalSystemPrompt = [
      globalBasePrompt
        ? `INSTRUCTIONS GÉNÉRALES (communes à tous les agents)\n${globalBasePrompt}`
        : "",
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR :\n${customPrompt}` : "",
      actionPolicy,
    ]
      .filter(Boolean)
      .join("\n\n");

    // Historique conversation (important)
    const { data: history, error: histErr } = await supabaseAdmin
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(30);

    if (histErr) {
      return res.status(500).json({ error: "Erreur chargement historique (messages)." });
    }

    // Appel LLM
    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: [
        { role: "system", content: finalSystemPrompt },
        ...(history || []).map((m) => ({
          role: safeStr(m.role) === "assistant" ? "assistant" : "user",
          content: safeStr(m.content),
        })),
        { role: "user", content: message },
      ],
      // Baisse la température pour fiabiliser les actions JSON
      temperature: 0.2,
    });

    const rawReply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";

    // Détecte action JSON et appelle Make si nécessaire
    const cmd = extractJsonCommand(rawReply);

    if (cmd && typeof cmd === "object" && cmd.action) {
      const action = safeStr(cmd.action).trim();

      if (action === "send_email") {
        const to = safeStr(cmd.to).trim();
        const subject = safeStr(cmd.subject).trim();
        const text = safeStr(cmd.text).trim();

        if (!to || !subject || !text) {
          return res.status(200).json({
            reply: "Il manque des informations pour envoyer l’email (to, subject, text).",
          });
        }

        const makeUrl = pickMakeWorkflowUrl(workflows, "send_email");
        if (!makeUrl) {
          return res.status(200).json({
            reply:
              "Aucun workflow Make configuré pour l’envoi d’email. Ajoutez un workflow (provider=make) dans la console admin.",
          });
        }

        try {
          await postToMake(makeUrl, {
            action: "send_email",
            to,
            subject,
            text,
            meta: { user_id: userId, agent_slug: agentSlugRaw, conversation_id: conversationId },
          });

          return res.status(200).json({
            reply: `C’est envoyé. Email à ${to} avec le sujet “${subject}”.`,
          });
        } catch (e) {
          console.error("Make send_email error:", e);
          return res.status(200).json({
            reply:
              "Je n’ai pas pu appeler Make pour envoyer l’email. Vérifiez : scénario Make ON, module Webhook correct, URL https://hook..., et droits Microsoft 365.",
          });
        }
      }

      if (action === "create_event") {
        const title = safeStr(cmd.title).trim();
        const start = safeStr(cmd.start).trim();
        const end = safeStr(cmd.end).trim();
        const notes = safeStr(cmd.notes).trim();

        if (!title || !start || !end) {
          return res.status(200).json({
            reply: "Il manque des informations pour créer le rendez-vous (title, start, end).",
          });
        }

        const makeUrl = pickMakeWorkflowUrl(workflows, "create_event");
        if (!makeUrl) {
          return res.status(200).json({
            reply:
              "Aucun workflow Make configuré pour l’agenda. Ajoutez un workflow (provider=make) dans la console admin.",
          });
        }

        try {
          await postToMake(makeUrl, {
            action: "create_event",
            title,
            start,
            end,
            notes,
            meta: { user_id: userId, agent_slug: agentSlugRaw, conversation_id: conversationId },
          });

          return res.status(200).json({
            reply: `Rendez-vous créé : “${title}” (${start} → ${end}).`,
          });
        } catch (e) {
          console.error("Make create_event error:", e);
          return res.status(200).json({
            reply:
              "Je n’ai pas pu appeler Make pour créer le rendez-vous. Vérifiez : scénario Make ON, URL webhook, et module agenda.",
          });
        }
      }
    }

    // Réponse normale
    return res.status(200).json({ reply: rawReply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
