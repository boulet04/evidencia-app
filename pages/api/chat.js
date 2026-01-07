// pages/api/chat.js
import agentPrompts from "../../lib/agentPrompts";
import { createClient } from "@supabase/supabase-js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

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

function normalizeUrlMaybe(u) {
  const s = safeStr(u).trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  // Si l’utilisateur met "www.bcontact.fr"
  if (s.startsWith("www.")) return "https://" + s;
  return s;
}

function isLikelyDoc(urlOrPath) {
  const s = safeStr(urlOrPath).trim();
  if (!s) return false;

  // Supporte les URL signées avec querystring : on regarde le pathname
  try {
    const u = new URL(s);
    const p = (u.pathname || "").toLowerCase();
    return (
      p.endsWith(".pdf") ||
      p.endsWith(".png") ||
      p.endsWith(".jpg") ||
      p.endsWith(".jpeg") ||
      p.endsWith(".webp") ||
      p.endsWith(".tiff") ||
      p.endsWith(".bmp") ||
      p.endsWith(".docx") ||
      p.endsWith(".pptx")
    );
  } catch {
    const p = s.toLowerCase();
    return (
      p.endsWith(".pdf") ||
      p.endsWith(".png") ||
      p.endsWith(".jpg") ||
      p.endsWith(".jpeg") ||
      p.endsWith(".webp") ||
      p.endsWith(".tiff") ||
      p.endsWith(".bmp") ||
      p.endsWith(".docx") ||
      p.endsWith(".pptx")
    );
  }
}

function truncate(text, maxChars) {
  const t = safeStr(text);
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n\n[...contenu tronqué...]";
}

/** Supabase Admin client (Service Role) */
function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL manquant.");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquant.");

  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}

/**
 * OCR Mistral: POST https://api.mistral.ai/v1/ocr
 */
async function mistralOcrFromUrl({ apiKey, url }) {
  const r = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.MISTRAL_OCR_MODEL || null,
      document: {
        type: "document_url",
        documentUrl: url,
      },
    }),
  });

  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = json?.message || json?.error || `OCR échoué (HTTP ${r.status})`;
    throw new Error(msg);
  }

  const pages = Array.isArray(json?.pages) ? json.pages : [];
  const merged = pages
    .map((p) => `--- Page ${p?.index ?? "?"} ---\n${p?.markdown || ""}`)
    .join("\n\n");

  return merged.trim();
}

async function fetchTextUrl(url) {
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "EvidenciaBot/1.0 (+https://evidencia-app.vercel.app)",
      Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8",
    },
  });

  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!r.ok) throw new Error(`Fetch URL échoué (HTTP ${r.status})`);

  // On limite aux contenus texte/html/json
  if (!ct.includes("text/") && !ct.includes("application/json") && !ct.includes("application/xhtml")) {
    return `Contenu non texte (${ct}).`;
  }

  return await r.text();
}

/**
 * Sources admin compatibles:
 * - url : { type:"url", url:"https://..." } (ou {value:"https://..."})
 * - pdf : { type:"pdf", path:"..." , bucket?:"agent_sources" }
 * - file (ancien) : { type:"file", bucket:"...", path:"..." }
 *
 * Retourne { text, debug }
 */
async function buildSourcesContext({ apiKey, supabaseAdmin, cfg }) {
  const ctxObj = parseMaybeJson(cfg?.context) || {};
  const sources = Array.isArray(ctxObj?.sources) ? ctxObj.sources : [];

  // Limite stricte pour éviter timeouts serverless
  const limited = sources.slice(0, 3);

  const parts = [];

  for (const s of limited) {
    const type = safeStr(s?.type).trim().toLowerCase();

    try {
      // ---- URL ----
      if (type === "url") {
        const rawUrl = safeStr(s?.url || s?.value).trim();
        const url = normalizeUrlMaybe(rawUrl);
        if (!url) continue;

        if (isLikelyDoc(url)) {
          const md = await mistralOcrFromUrl({ apiKey, url });
          parts.push(`SOURCE (OCR URL) : ${url}\n${truncate(md, 12000)}`);
        } else {
          const txt = await fetchTextUrl(url);
          parts.push(`SOURCE (URL TEXTE) : ${url}\n${truncate(txt, 8000)}`);
        }
      }

      // ---- FICHIER (ancien) ----
      if (type === "file") {
        const bucket = safeStr(s?.bucket).trim();
        const path = safeStr(s?.path).trim();
        const name = safeStr(s?.name).trim();

        if (!bucket || !path) continue;

        const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, 600);
        if (error || !data?.signedUrl) {
          parts.push(`SOURCE (FICHIER) : ${name || path}\nImpossible de générer l’URL signée.`);
          continue;
        }

        const signedUrl = data.signedUrl;

        if (isLikelyDoc(path) || isLikelyDoc(name)) {
          const md = await mistralOcrFromUrl({ apiKey, url: signedUrl });
          parts.push(`SOURCE (OCR FICHIER) : ${name || path}\n${truncate(md, 12000)}`);
        } else {
          const txt = await fetchTextUrl(signedUrl);
          parts.push(`SOURCE (FICHIER TEXTE) : ${name || path}\n${truncate(txt, 8000)}`);
        }
      }

      // ---- PDF (nouveau admin) ----
      if (type === "pdf") {
        const bucket = safeStr(s?.bucket).trim() || "agent_sources";
        const path = safeStr(s?.path).trim();
        const name = safeStr(s?.name).trim();

        if (!path) continue;

        const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, 600);
        if (error || !data?.signedUrl) {
          parts.push(`SOURCE (PDF) : ${name || path}\nImpossible de générer l’URL signée.`);
          continue;
        }

        const md = await mistralOcrFromUrl({ apiKey, url: data.signedUrl });
        parts.push(`SOURCE (OCR PDF) : ${name || path}\n${truncate(md, 12000)}`);
      }
    } catch (e) {
      parts.push(`SOURCE (ERREUR) : ${type}\n${safeStr(e?.message || e)}`);
    }
  }

  const text =
    parts.length === 0
      ? ""
      : `\n\nDOCUMENTATION FOURNIE (à utiliser en priorité si pertinent) :\n` +
        parts.map((p, i) => `\n[Source ${i + 1}]\n${p}\n`).join("\n");

  const debug = parts.join("\n\n---\n\n").slice(0, 4000);

  return { text, debug };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "MISTRAL_API_KEY manquant sur Vercel." });

    const supabaseAdmin = getSupabaseAdmin();

    // Auth user via Bearer token (access_token Supabase)
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    }
    const userId = userData.user.id;

    // Body
    const { message, agentSlug } = req.body || {};
    const slug = safeStr(agentSlug).trim().toLowerCase();
    const userMsg = safeStr(message).trim();

    if (!slug) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!userMsg) return res.status(400).json({ error: "Message vide." });

    // Charger agent
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (agentErr || !agent) return res.status(404).json({ error: "Agent introuvable." });

    // Vérifier assignation
    const { data: assignment, error: assignErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (assignErr) return res.status(500).json({ error: "Erreur assignation (user_agents)." });
    if (!assignment) return res.status(403).json({ error: "Accès interdit : agent non assigné." });

    // Prompt personnalisé + context (sources)
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

    const behavioral =
      `\n\nRÈGLES DE STYLE :\n` +
      `- Ne répète pas “bonjour” à chaque réponse. Salue au maximum une fois au début d’une nouvelle conversation.\n` +
      `- Réponds directement, de manière professionnelle, sans te représenter (“je suis Emma…”) sauf si on te le demande.\n` +
      `- Si une documentation est fournie (sources), utilise-la en priorité et explique ce que tu en déduis.\n` +
      `- Ne jamais inventer de faits. Si tu ne sais pas, dis-le.\n`;

    const { text: sourcesContext, debug: sourcesDebug } = await buildSourcesContext({
      apiKey,
      supabaseAdmin,
      cfg,
    });

    const finalSystemPrompt = customPrompt
      ? `${basePrompt}\n\nINSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR :\n${customPrompt}${behavioral}${sourcesContext}`
      : `${basePrompt}${behavioral}${sourcesContext}`;

    // Appel Mistral Chat Completions
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.MISTRAL_MODEL || "mistral-small-latest",
        temperature: 0.7,
        messages: [
          { role: "system", content: finalSystemPrompt },
          { role: "user", content: userMsg },
        ],
      }),
    });

    const json = await r.json().catch(() => null);
    if (!r.ok) {
      return res.status(500).json({
        error: "Erreur Mistral",
        detail: json?.message || json?.error || JSON.stringify(json) || `HTTP ${r.status}`,
        sources_debug: sourcesDebug || "",
      });
    }

    const reply = safeStr(json?.choices?.[0]?.message?.content).trim() || "Réponse vide.";

    return res.status(200).json({
      reply,
      answer: reply,
      content: reply,
      ok: true,
      sources_debug: sourcesDebug || "",
    });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({
      error: "Erreur interne de l’agent.",
      detail: safeStr(err?.message || err),
    });
  }
}
