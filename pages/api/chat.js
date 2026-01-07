// pages/api/chat.js
import Mistral from "@mistralai/mistralai";
import agentPrompts from "../../lib/agentPrompts";
import { supabaseAdmin, getBearerToken, safeStr } from "../../lib/supabaseAdmin";

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

function looksLikePdf(url) {
  return /\.pdf(\?|#|$)/i.test(safeStr(url));
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

    const sb = supabaseAdmin();

    // 1) Auth user via Bearer token
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    }
    const userId = userData.user.id;

    // 2) Body
    const { message, agentSlug } = req.body || {};
    const slug = safeStr(agentSlug).trim().toLowerCase();
    const userMsg = safeStr(message).trim();

    if (!slug) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!userMsg) return res.status(400).json({ error: "Message vide." });

    // 3) Charger agent
    const { data: agent, error: agentErr } = await sb
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (agentErr || !agent) return res.status(404).json({ error: "Agent introuvable." });

    // 4) Vérifier assignation
    const { data: assignment, error: assignErr } = await sb
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (assignErr) return res.status(500).json({ error: "Erreur assignation (user_agents)." });
    if (!assignment) return res.status(403).json({ error: "Accès interdit : agent non assigné." });

    // 5) Charger config agent (prompt + sources)
    const { data: cfg, error: cfgErr } = await sb
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    const ctxObj = !cfgErr ? parseMaybeJson(cfg?.context) : null;

    const customPrompt = safeStr(cfg?.system_prompt).trim();
    const basePrompt =
      safeStr(agentPrompts?.[slug]?.systemPrompt).trim() ||
      `Tu es ${agent.name}${agent.description ? `, ${agent.description}` : ""}.`;

    // Important: éviter “Bonjour je suis …” à répétition
    const antiSpam =
      "Règles de style: ne répète pas ton introduction. Ne dis pas 'Bonjour je suis ...' à chaque message. " +
      "Va directement au contenu utile. Si tu as besoin d’un document, demande lequel.";

    const finalSystemPrompt = customPrompt
      ? `${basePrompt}\n\n${antiSpam}\n\nINSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR :\n${customPrompt}`
      : `${basePrompt}\n\n${antiSpam}`;

    // 6) Préparer les documents (sources) => document_url
    const sources = Array.isArray(ctxObj?.sources) ? ctxObj.sources : [];
    const docUrls = [];

    for (const s of sources.slice(0, 3)) {
      if (s?.type === "url" && s?.value) {
        docUrls.push({ url: safeStr(s.value).trim(), label: "url" });
      }

      if (s?.type === "file" && s?.bucket && s?.path) {
        const bucket = safeStr(s.bucket).trim();
        const path = safeStr(s.path).trim();

        const { data: signed, error: sErr } = await sb.storage
          .from(bucket)
          .createSignedUrl(path, 600);

        if (!sErr && signed?.signedUrl) {
          docUrls.push({ url: signed.signedUrl, label: safeStr(s.name || "file") });
        }
      }
    }

    // On ne force pas: si pas de doc => chat normal
    const userContent = docUrls.length
      ? [
          { type: "text", text: userMsg },
          ...docUrls.map((d) => ({ type: "document_url", document_url: d.url })),
        ]
      : userMsg;

    // Petit warning “Word/Excel” => recommander PDF
    const docHint =
      docUrls.length && docUrls.some((d) => !looksLikePdf(d.url))
        ? "\n\nNote: si certains fichiers ne sont pas des PDF, exporte-les en PDF pour une lecture fiable."
        : "";

    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: [
        { role: "system", content: finalSystemPrompt + docHint },
        { role: "user", content: userContent },
      ],
      temperature: 0.7,
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
