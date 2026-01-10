// pages/api/chat.js
import { Mistral } from "@mistralai/mistralai";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import agentPrompts from "../../lib/agentPrompts";

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractJsonCommand(text) {
  // On accepte:
  // - un JSON brut
  // - un bloc ```json ... ```
  const t = String(text || "").trim();

  if (!t) return null;

  // bloc ```json
  const fenced = t.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    const obj = safeJsonParse(fenced[1].trim());
    return obj;
  }

  // JSON brut
  if (t.startsWith("{") && t.endsWith("}")) {
    return safeJsonParse(t);
  }

  return null;
}

function pickWorkflowUrl(workflows, kind) {
  // workflows: [{provider,name,url}]
  const list = Array.isArray(workflows) ? workflows : [];
  const makeList = list.filter((w) => String(w?.provider || "").toLowerCase() === "make" && /^https?:\/\//i.test(String(w?.url || "")));

  if (makeList.length === 0) return null;

  if (kind === "send_email") {
    // priorité aux noms contenant mail/email
    const hit =
      makeList.find((w) => /mail|email/i.test(String(w?.name || ""))) ||
      makeList[0];
    return hit?.url || null;
  }

  if (kind === "create_event") {
    const hit =
      makeList.find((w) => /agenda|calendar|calendrier|rdv|rendez/i.test(String(w?.name || ""))) ||
      makeList[0];
    return hit?.url || null;
  }

  return makeList[0]?.url || null;
}

async function postToMake(url, payload) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw new Error(`Make webhook error (${resp.status}) ${text?.slice(0, 300)}`);
  }
  return text;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const { data: authData, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !authData?.user) return res.status(401).json({ error: "Unauthorized" });

  const user = authData.user;

  const { conversation_id, agent_slug, message } = req.body || {};
  const msg = String(message || "").trim();
  const agentSlug = String(agent_slug || "").trim();

  if (!agentSlug) return res.status(400).json({ error: "Aucun agent sélectionné." });
  if (!msg) return res.status(400).json({ error: "Message vide." });
  if (!conversation_id) return res.status(400).json({ error: "conversation_id manquant." });

  // 1) Vérifier que la conversation appartient à ce user
  const { data: conv, error: convErr } = await supabaseAdmin
    .from("conversations")
    .select("id,user_id,agent_slug")
    .eq("id", conversation_id)
    .maybeSingle();

  if (convErr || !conv) return res.status(404).json({ error: "Conversation introuvable." });
  if (conv.user_id !== user.id) return res.status(403).json({ error: "Forbidden" });

  // 2) Charger l'agent
  const { data: agent, error: agentErr } = await supabaseAdmin
    .from("agents")
    .select("id,slug,name,description")
    .eq("slug", agentSlug)
    .maybeSingle();

  if (agentErr || !agent) return res.status(404).json({ error: "Agent introuvable." });

  // 3) Charger config perso (prompt + context : sources/workflows)
  const { data: cfg, error: cfgErr } = await supabaseAdmin
    .from("client_agent_configs")
    .select("system_prompt,context")
    .eq("user_id", user.id)
    .eq("agent_id", agent.id)
    .maybeSingle();

  if (cfgErr) {
    // on continue même si vide
  }

  const systemPromptPerso = String(cfg?.system_prompt || "");
  const context = cfg?.context || {};
  const workflows = Array.isArray(context?.workflows) ? context.workflows : [];
  const sources = Array.isArray(context?.sources) ? context.sources : [];

  // 4) Charger historique messages (limité)
  const { data: history, error: histErr } = await supabaseAdmin
    .from("messages")
    .select("role,content,created_at")
    .eq("conversation_id", conversation_id)
    .order("created_at", { ascending: true })
    .limit(30);

  if (histErr) {
    return res.status(500).json({ error: "Impossible de charger l'historique." });
  }

  const basePrompt = agentPrompts?.[agentSlug] || "";
  const workflowsListText = workflows
    .map((w) => `- provider=${w?.provider || ""} name=${w?.name || ""} url=${w?.url ? "[set]" : "[missing]"}`)
    .join("\n");

  // Instruction d'actions : le modèle doit rendre un JSON quand il faut exécuter
  const actionPolicy = `
Tu peux exécuter des actions via des workflows Make configurés. 
WORKFLOWS DISPONIBLES (pour cet utilisateur / cet agent) :
${workflowsListText || "- (aucun)"}

RÈGLE IMPORTANTE :
- Si l'utilisateur demande "envoyer un mail", réponds UNIQUEMENT par un JSON (et rien d'autre) au format :
{
  "action": "send_email",
  "to": "email@domaine.fr",
  "subject": "Sujet",
  "text": "Contenu du mail"
}

- Si l'utilisateur demande "créer un rendez-vous / un évènement agenda", réponds UNIQUEMENT par un JSON au format :
{
  "action": "create_event",
  "title": "Titre",
  "start": "2026-01-10T14:00:00",
  "end": "2026-01-10T14:30:00",
  "notes": "Détails optionnels"
}

Si un champ manque, pose une question au lieu d'inventer (ex: "à quelle adresse mail ?" / "quelle date et heure ?").
`;

  const messages = [
    {
      role: "system",
      content: [basePrompt, systemPromptPerso, actionPolicy].filter(Boolean).join("\n\n"),
    },
    ...(history || []).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || ""),
    })),
    { role: "user", content: msg },
  ];

  // 5) Appel Mistral
  const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY || "" });

  let assistantText = "";
  try {
    const r = await client.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-large-latest",
      messages,
      temperature: 0.2,
    });

    assistantText = r?.choices?.[0]?.message?.content || "";
  } catch (e) {
    console.error("Mistral error:", e);
    return res.status(500).json({ error: "Erreur IA." });
  }

  // 6) Si le modèle renvoie un JSON d'action => on appelle Make
  const cmd = extractJsonCommand(assistantText);

  if (cmd && typeof cmd === "object" && cmd.action) {
    const action = String(cmd.action || "").trim();

    if (action === "send_email") {
      const to = String(cmd.to || "").trim();
      const subject = String(cmd.subject || "").trim();
      const text = String(cmd.text || "").trim();

      if (!to || !subject || !text) {
        return res.status(200).json({
          reply: "Il manque des informations pour envoyer le mail (destinataire, sujet ou contenu).",
        });
      }

      const makeUrl = pickWorkflowUrl(workflows, "send_email");
      if (!makeUrl) {
        return res.status(200).json({
          reply:
            "Aucun workflow Make configuré pour l’envoi d’email. Ajoutez un workflow (provider=make) dans la console admin (Prompt, données & workflows).",
        });
      }

      try {
        await postToMake(makeUrl, {
          action: "send_email",
          to,
          subject,
          text,
          meta: { user_id: user.id, agent_slug: agentSlug, conversation_id },
        });

        return res.status(200).json({
          reply: `C’est envoyé. Email à ${to} avec le sujet “${subject}”.`,
        });
      } catch (e) {
        console.error("Make send_email error:", e);
        return res.status(200).json({
          reply: "Je n’ai pas réussi à appeler Make pour envoyer l’email. Vérifiez que le scénario est ON et que l’URL du webhook est correcte.",
        });
      }
    }

    if (action === "create_event") {
      const title = String(cmd.title || "").trim();
      const start = String(cmd.start || "").trim();
      const end = String(cmd.end || "").trim();
      const notes = String(cmd.notes || "").trim();

      if (!title || !start || !end) {
        return res.status(200).json({
          reply: "Il manque des informations pour créer le rendez-vous (titre, start, end).",
        });
      }

      const makeUrl = pickWorkflowUrl(workflows, "create_event");
      if (!makeUrl) {
        return res.status(200).json({
          reply:
            "Aucun workflow Make configuré pour l’agenda. Ajoutez un workflow (provider=make) dans la console admin (Prompt, données & workflows).",
        });
      }

      try {
        await postToMake(makeUrl, {
          action: "create_event",
          title,
          start,
          end,
          notes,
          meta: { user_id: user.id, agent_slug: agentSlug, conversation_id },
        });

        return res.status(200).json({
          reply: `Rendez-vous créé : “${title}” (${start} → ${end}).`,
        });
      } catch (e) {
        console.error("Make create_event error:", e);
        return res.status(200).json({
          reply: "Je n’ai pas réussi à appeler Make pour créer le rendez-vous. Vérifiez le scénario et l’URL du webhook.",
        });
      }
    }
  }

  // 7) Réponse normale (pas d'action)
  return res.status(200).json({ reply: assistantText || "" });
}
