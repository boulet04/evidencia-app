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

/**
 * Détermine si on est en intention "préparer" (draft) ou "envoyer" (send).
 * - DRAFT: "prépare / rédige / brouillon / draft" ET PAS "envoie/envoyer/envoi"
 * - SEND : contient "envoie/envoyer/envoi"
 * Sinon: normal
 */
function detectEmailMode(userMsg) {
  const t = safeStr(userMsg).toLowerCase();

  const hasSend =
    /\b(envoie|envoyer|envoi|send)\b/i.test(t) ||
    /\b(envoie-moi|envoie lui|envoie à)\b/i.test(t);

  const hasDraft =
    /\b(prépare|prepare|rédige|redige|brouillon|draft)\b/i.test(t);

  if (hasSend) return "SEND";
  if (hasDraft) return "DRAFT";
  return "NORMAL";
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

    // IMPORTANT: accepter agentSlug OU agent (body ou query)
    const body = req.body || {};
    const message = safeStr(body?.message).trim();

    const rawSlug =
      safeStr(body?.agentSlug) ||
      safeStr(body?.agent) ||
      safeStr(req.query?.agentSlug) ||
      safeStr(req.query?.agent) ||
      "";

    const slug = safeStr(rawSlug).trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!message) return res.status(400).json({ error: "Message vide." });

    const emailMode = detectEmailMode(message);

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

    // Règles robustes anti-envoi accidentel :
    // - En DRAFT: interdiction ABSOLUE de JSON {to,subject,body}
    // - En SEND : JSON strict UNIQUEMENT, body en HTML
    const emailSafetyBlock = `
MODE_EMAIL=${emailMode}

RÈGLES EMAIL (IMPORTANTES)
- Si MODE_EMAIL=DRAFT :
  - Tu DOIS préparer un brouillon lisible (texte/markdown) avec sections :
    "Destinataire:", "Objet:", puis le corps en paragraphes séparés par une ligne vide.
  - Interdiction totale de produire un JSON avec les clés exactes "to", "subject", "body".
  - Termine par : "Si vous souhaitez l'envoyer, dites simplement : envoie."
- Si MODE_EMAIL=SEND :
  - Tu DOIS renvoyer UNIQUEMENT un JSON strict (aucun texte autour, pas de backticks) avec EXACTEMENT ces clés :
    {"to":"...","subject":"...","body":"..."}
  - "to" doit être une adresse email valide (une seule).
  - "subject" doit être court et professionnel.
  - "body" doit être du HTML (avec <p>, <br>, <strong> si utile) afin que l'email soit bien structuré dans Outlook.
  - Ne mets JAMAIS de placeholders du type "[A COMPLETER]". Si une info manque, pose UNE question courte au lieu de générer le JSON.
`;

    const finalSystemPrompt = [
      globalBasePrompt
        ? `INSTRUCTIONS GÉNÉRALES (communes à tous les agents)\n${globalBasePrompt}`
        : "",
      basePrompt,
      customPrompt ? `INSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR :\n${customPrompt}` : "",
      emailSafetyBlock.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: [
        { role: "system", content: finalSystemPrompt },
        { role: "user", content: message },
      ],
      temperature: 0.4,
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
