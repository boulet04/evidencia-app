// pages/api/chat.js
import Mistral from "@mistralai/mistralai";
import agentPrompts from "../../lib/agentPrompts";
import { createClient } from "@supabase/supabase-js";

const TABLE_CONVERSATIONS = "conversations";
const TABLE_MESSAGES = "messages"; // ✅ table Supabase (messages)

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// Supabase Admin (service role) -> uniquement côté serveur
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

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

function stripHtmlToText(html) {
  const s = safeStr(html);
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function guessExt(nameOrPath) {
  const s = safeStr(nameOrPath).toLowerCase();
  const i = s.lastIndexOf(".");
  return i >= 0 ? s.slice(i + 1) : "";
}

function isTextLike(ext, mime) {
  const e = safeStr(ext).toLowerCase();
  const m = safeStr(mime).toLowerCase();
  if (m.startsWith("text/")) return true;
  if (m.includes("json") || m.includes("csv")) return true;
  return ["txt", "md", "csv", "json", "log"].includes(e);
}

function isPdf(ext, mime) {
  const e = safeStr(ext).toLowerCase();
  const m = safeStr(mime).toLowerCase();
  return e === "pdf" || m.includes("pdf");
}

function isExcel(ext, mime) {
  const e = safeStr(ext).toLowerCase();
  const m = safeStr(mime).toLowerCase();
  if (e === "xlsx" || e === "xls") return true;
  return (
    m.includes("spreadsheetml") ||
    m.includes("ms-excel") ||
    m.includes("application/vnd")
  );
}

async function fetchWithTimeout(url, timeoutMs = 8000, as = "text") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    const ct = r.headers.get("content-type") || "";
    if (as === "arrayBuffer") {
      const ab = await r.arrayBuffer();
      return { ok: r.ok, status: r.status, contentType: ct, data: ab };
    }
    const tx = await r.text();
    return { ok: r.ok, status: r.status, contentType: ct, data: tx };
  } catch (e) {
    return { ok: false, status: 0, contentType: "", data: as === "arrayBuffer" ? null : "" };
  } finally {
    clearTimeout(t);
  }
}

async function extractPdfTextFromArrayBuffer(arrayBuffer) {
  // nécessite: npm i pdf-parse
  try {
    const mod = await import("pdf-parse");
    const pdfParse = mod?.default || mod;
    const buf = Buffer.from(arrayBuffer);
    const parsed = await pdfParse(buf);
    const text = safeStr(parsed?.text);
    return text.replace(/\s+/g, " ").trim();
  } catch (e) {
    return "";
  }
}

async function extractXlsxTextFromArrayBuffer(arrayBuffer) {
  // nécessite: npm i xlsx
  try {
    const xlsx = await import("xlsx");
    const XLSX = xlsx?.default || xlsx;
    const buf = Buffer.from(arrayBuffer);

    const wb = XLSX.read(buf, { type: "buffer" });
    const sheetNames = wb.SheetNames || [];
    const chunks = [];

    for (const name of sheetNames.slice(0, 3)) {
      const ws = wb.Sheets[name];
      if (!ws) continue;

      // Convertit en CSV (lisible par LLM)
      const csv = XLSX.utils.sheet_to_csv(ws, { FS: ";", RS: "\n" });
      const clean = safeStr(csv).trim();
      if (clean) chunks.push(`--- Feuille: ${name}\n${clean}`);
    }

    return chunks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch (e) {
    return "";
  }
}

function clampText(t, maxChars) {
  const s = safeStr(t);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "\n[…extrait tronqué…]";
}

function buildBehaviorRules() {
  return (
    "RÈGLES DE STYLE:\n" +
    "- Ne te présente pas à chaque message.\n" +
    "- Évite les salutations répétées (« Bonjour ») sauf au tout premier message.\n" +
    "- Réponds de manière opérationnelle, structurée, sans blabla.\n" +
    "- Si une info manque, pose UNE question précise.\n"
  );
}

function safePublicError(err) {
  // Ne pas leak les clés, mais rendre lisible.
  const msg = safeStr(err?.message || err);
  if (!msg) return "Erreur interne.";
  return msg.length > 220 ? msg.slice(0, 220) + "…" : msg;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    // env checks
    if (!process.env.MISTRAL_API_KEY) {
      return res.status(500).json({ error: "MISTRAL_API_KEY manquant sur Vercel." });
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant sur Vercel." });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant sur Vercel." });
    }

    // 1) Auth user via Bearer token
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié (token manquant)." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Session invalide. Reconnectez-vous." });
    }
    const userId = userData.user.id;

    // 2) Body (tolère camelCase et snake_case)
    const body = req.body || {};
    const message = body.message ?? body.msg ?? "";
    const agentSlug = body.agentSlug ?? body.agent_slug ?? body.slug ?? "";
    const conversationId = body.conversationId ?? body.conversation_id ?? "";
    const slug = safeStr(agentSlug).trim().toLowerCase();
    const userMsg = safeStr(message).trim();
    const convId = safeStr(conversationId).trim();

    if (!slug) return res.status(400).json({ error: "Aucun agent sélectionné." });
    if (!userMsg) return res.status(400).json({ error: "Message vide." });

    // 3) Charger agent
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    if (agentErr || !agent) return res.status(404).json({ error: "Agent introuvable." });

    // 4) Vérifier assignation user_agents
    const { data: assignment, error: assignErr } = await supabaseAdmin
      .from("user_agents")
      .select("user_id, agent_id")
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (assignErr) return res.status(500).json({ error: "Erreur assignation (user_agents)." });
    if (!assignment) return res.status(403).json({ error: "Accès interdit : agent non assigné." });

    // 5) Si conversationId fourni => vérifier ownership (sinon on continue sans historique)
    if (convId) {
      const { data: conv, error: convErr } = await supabaseAdmin
        .from(TABLE_CONVERSATIONS)
        .select("id, user_id, agent_slug")
        .eq("id", convId)
        .eq("agent_slug", agent.slug)
        .maybeSingle();

      if (convErr || !conv) {
        // pas bloquant si front est en retard, mais on enlève l’historique
        // et on continue pour éviter “Erreur API”
      }
    }

    // 6) Charger prompt + sources
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
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

    const behaviorRules = buildBehaviorRules();


    // 6bis) Prompt global (défini via /admin/settings)
    let globalPrompt = "";
    try {
      const { data: gp } = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", "base_system_prompt")
        .maybeSingle();
      globalPrompt = safeStr(gp?.value).trim();
    } catch (_) {
      // ignore
    }


    // 7) SOURCES -> extractions (URL + fichiers texte/csv + PDF + XLSX)
    const sources = Array.isArray(ctxObj?.sources) ? ctxObj.sources : [];
    const extracted = [];

    // 7a) URLs
    for (const s of sources) {
      const urlVal = safeStr(s?.value || s?.url || s?.href).trim();
      if (s?.type === "url" && urlVal) {
        const url = urlVal;
        const r = await fetchWithTimeout(url, 7000, "text");
        if (r.ok) {
          const text = clampText(stripHtmlToText(r.data), 7000);
          if (text) extracted.push({ label: `URL: ${url}`, text });
        }
      }
    }

    // 7b) Storage files
    for (const s of sources) {
      if (s?.type !== "file" || !s?.bucket || !s?.path) continue;

      const bucket = safeStr(s.bucket).trim();
      const path = safeStr(s.path).trim();
      const name = safeStr(s.name).trim();
      const mime = safeStr(s.mime).trim();
      const ext = guessExt(name || path);

      const { data: signed, error: signErr } = await supabaseAdmin.storage
        .from(bucket)
        .createSignedUrl(path, 60);

      if (signErr || !signed?.signedUrl) continue;

      // Texte / CSV / JSON
      if (isTextLike(ext, mime)) {
        const r = await fetchWithTimeout(signed.signedUrl, 7000, "text");
        if (r.ok) {
          const text = clampText(safeStr(r.data).trim(), 9000);
          if (text) extracted.push({ label: `Fichier: ${name || path}`, text });
        }
        continue;
      }

      // PDF
      if (isPdf(ext, mime)) {
        const r = await fetchWithTimeout(signed.signedUrl, 9000, "arrayBuffer");
        if (r.ok && r.data) {
          const pdfText = await extractPdfTextFromArrayBuffer(r.data);
          const text = clampText(pdfText, 9000);
          if (text) extracted.push({ label: `PDF: ${name || path}`, text });
        }
        continue;
      }

      // Excel
      if (isExcel(ext, mime)) {
        const r = await fetchWithTimeout(signed.signedUrl, 9000, "arrayBuffer");
        if (r.ok && r.data) {
          const xText = await extractXlsxTextFromArrayBuffer(r.data);
          const text = clampText(xText, 9000);
          if (text) extracted.push({ label: `Excel: ${name || path}`, text });
        }
        continue;
      }

      // Sinon ignoré
    }

    const sourcesBlock =
      extracted.length > 0
        ? "SOURCES FOURNIES (EXTRAITS):\n" +
          extracted
            .slice(0, 5)
            .map((x) => `--- ${x.label}\n${x.text}\n`)
            .join("\n")
        : "";

    const headPrompt = globalPrompt ? `${globalPrompt}\n\n${basePrompt}` : basePrompt;

    const finalSystemPrompt =
      (customPrompt
        ? `${headPrompt}\n\nINSTRUCTIONS PERSONNALISÉES POUR CET UTILISATEUR:\n${customPrompt}\n\n`
        : `${headPrompt}\n\n`) +
      behaviorRules +
      (sourcesBlock ? `\n${sourcesBlock}\n` : "");

    // 8) Historique conversation (si convId fourni)
    let hist = [];
    if (convId) {
      const { data: histRows, error: histErr } = await supabaseAdmin
        .from(TABLE_MESSAGES)
        .select("role, content, created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (!histErr && Array.isArray(histRows)) {
        hist = histRows.slice().reverse();
      }
    }

    const chatMessages = [
      { role: "system", content: finalSystemPrompt },
      ...hist.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: safeStr(m.content),
      })),
      { role: "user", content: userMsg },
    ];

    // 9) Appel Mistral
    const completion = await mistral.chat.complete({
      model: process.env.MISTRAL_MODEL || "mistral-small-latest",
      messages: chatMessages,
      temperature: 0.4,
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    // ✅ renvoyer un message exploitable côté UI
    return res.status(500).json({
      error: "Erreur interne API",
      detail: safePublicError(err),
    });
  }
}
