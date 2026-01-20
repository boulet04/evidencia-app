// pages/api/chat.js
// API Next.js (pages router) :
// - verifie le token Supabase de l'utilisateur
// - verifie acces a l'agent (user_agents)
// - cree/valide la conversation
// - insere le message user
// - charge config agent (client_agent_configs) + sources (CSV depuis Storage)
// - appelle Mistral via HTTP
// - insere la reponse assistant

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

function safeStr(v) {
  return (v ?? "").toString();
}

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^a-z0-9àâäéèêëïîôöùûüç@._\- ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickDelimiter(sampleLine) {
  const comma = (sampleLine.match(/,/g) || []).length;
  const semi = (sampleLine.match(/;/g) || []).length;
  const tab = (sampleLine.match(/\t/g) || []).length;
  if (tab >= semi && tab >= comma && tab > 0) return "\t";
  if (semi >= comma && semi > 0) return ";";
  return ",";
}

// CSV parser simple (support guillemets "...")
function parseCsv(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const delimiter = pickDelimiter(lines[0]);

  const parseLine = (line) => {
    const out = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        // "" -> "
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (!inQuotes && ch === delimiter) {
        out.push(cur);
        cur = "";
        continue;
      }

      cur += ch;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };

  const headers = parseLine(lines[0]).map((h, idx) => (h ? h : `col_${idx + 1}`));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[j] ?? "";
    }
    rows.push(obj);
  }

  return { headers, rows };
}

function rowToSearchableString(row) {
  try {
    return normalizeText(Object.values(row || {}).join(" "));
  } catch {
    return "";
  }
}

function extractQueryTokens(userMessage) {
  const msg = normalizeText(userMessage);
  const tokens = msg.split(" ").filter(Boolean);

  // stopwords FR/EN minimal (garde @, . etc déjà gérés)
  const stop = new Set([
    "le", "la", "les", "un", "une", "des", "du", "de", "d", "et", "ou",
    "a", "à", "au", "aux", "pour", "par", "sur", "dans", "avec", "sans",
    "stp", "svp", "merci", "bonjour", "salut",
    "peux", "tu", "me", "donner", "liste", "lister", "mails", "mail", "emails", "email",
    "societe", "société", "entreprise", "contact", "contacts"
  ]);

  // garde tokens utiles et un peu longs
  return tokens.filter((t) => t.length >= 3 && !stop.has(t));
}

function scoreRow(rowStr, tokens) {
  let score = 0;
  for (const t of tokens) {
    if (rowStr.includes(t)) score += 2;
    // bonus si token ressemble à un domaine (ex: bcontact.fr)
    if (t.includes(".") && rowStr.includes(t)) score += 2;
  }
  return score;
}

function topRelevantRows(rows, userMessage, maxRows = 20) {
  const tokens = extractQueryTokens(userMessage);
  if (tokens.length === 0) return [];

  const scored = rows
    .map((r) => {
      const s = rowToSearchableString(r);
      return { row: r, score: scoreRow(s, tokens) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, maxRows).map((x) => x.row);
}

function safeTruncate(str, maxChars) {
  const s = String(str || "");
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "\n…(tronqué)";
}

async function downloadTextFromStorage(supabase, bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    const err = new Error(`Storage download failed for ${bucket}/${path}: ${error?.message || "unknown"}`);
    err.code = "STORAGE_DOWNLOAD_FAILED";
    err.detail = { bucket, path, error: error?.message || null };
    throw err;
  }

  // data est un Blob (Node 18+)
  if (typeof data.text === "function") {
    return await data.text();
  }

  // fallback: arrayBuffer -> Buffer
  const ab = await data.arrayBuffer();
  return Buffer.from(ab).toString("utf-8");
}

function buildSourceContextBlock({ fileName, headers, sampleRows, warning }) {
  // on évite de balancer tout le fichier : max 20 lignes, max 8k chars
  const lines = [];

  lines.push(`SOURCE CSV: ${fileName}`);
  if (headers?.length) {
    lines.push(`Colonnes: ${headers.join(", ")}`);
  }

  if (warning) {
    lines.push(`Note: ${warning}`);
  }

  if (!sampleRows || sampleRows.length === 0) {
    lines.push("Aucune ligne pertinente trouvée pour la demande actuelle.");
    lines.push("=> IMPORTANT: demander le nom exact de la société ou le domaine email (ex: bcontact.fr) pour filtrer.");
    return lines.join("\n");
  }

  lines.push("Lignes pertinentes (extrait limité):");
  for (const r of sampleRows) {
    // format compact clé=val
    const entries = Object.entries(r || {})
      .slice(0, 12)
      .map(([k, v]) => `${k}=${String(v || "").replace(/\s+/g, " ").trim()}`)
      .join(" | ");
    lines.push(`- ${entries}`);
  }

  return safeTruncate(lines.join("\n"), 8000);
}

async function buildSourcesContext({ supabase, context, userMessage }) {
  const sources = context?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return "";

  const blocks = [];

  for (const src of sources) {
    const name = src?.name || "";
    const mime = src?.mime || "";
    const path = src?.path || "";
    const bucket = src?.bucket || "agent_sources";

    // On traite uniquement les CSV
    const isCsv =
      mime.toLowerCase().includes("text/csv") ||
      name.toLowerCase().endsWith(".csv") ||
      path.toLowerCase().endsWith(".csv");

    if (!isCsv) continue;
    if (!path) continue;

    let text = "";
    let warning = "";

    try {
      text = await downloadTextFromStorage(supabase, bucket, path);
      // garde-fou taille (évite énorme injection prompt)
      if (text.length > 1_200_000) {
        warning = `Fichier très volumineux (${text.length} chars). Seules les premières lignes peuvent être exploitées.`;
        text = text.slice(0, 250_000);
      }
    } catch (e) {
      blocks.push(
        buildSourceContextBlock({
          fileName: name || path,
          headers: [],
          sampleRows: [],
          warning: `Impossible de télécharger la source (${e?.message || "erreur"}).`,
        })
      );
      continue;
    }

    const { headers, rows } = parseCsv(text);

    // filtre lignes pertinentes selon le message user
    const relevant = topRelevantRows(rows, userMessage, 20);

    blocks.push(
      buildSourceContextBlock({
        fileName: name || path,
        headers,
        sampleRows: relevant,
        warning,
      })
    );
  }

  if (blocks.length === 0) return "";

  // Règles d'utilisation des sources (évite extraction massive)
  const guardrails = [
    "REGLES IMPORTANTES (DONNEES INTERNES):",
    "- Utiliser ces sources uniquement pour répondre à la demande.",
    "- Ne JAMAIS lister tout le fichier ni fournir des extractions massives.",
    "- Si la société / le domaine n'est pas précisé, poser une question de clarification (nom exact ou domaine).",
    "- Limiter la réponse à un petit nombre de résultats (ex: 10) et proposer d'affiner.",
  ].join("\n");

  return `\n\n${guardrails}\n\n${blocks.join("\n\n---\n\n")}`;
}

async function callMistral({ systemPrompt, history, userMessage }) {
  if (!MISTRAL_API_KEY) {
    const err = new Error("MISTRAL_API_KEY manquant dans Vercel env.");
    err.code = "NO_MISTRAL_KEY";
    throw err;
  }

  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    ...history,
    { role: "user", content: userMessage },
  ];

  const payload = {
    model: "mistral-small-latest",
    messages,
    temperature: 0.2,
  };

  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!r.ok) {
    const err = new Error(`Mistral HTTP ${r.status}`);
    err.code = "MISTRAL_HTTP";
    err.status = r.status;
    err.detail = data || text;
    throw err;
  }

  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) {
    const err = new Error("Reponse Mistral inattendue (choices[0].message.content manquant).");
    err.code = "MISTRAL_BAD_RESPONSE";
    err.detail = data;
    throw err;
  }

  return reply;
}

async function loadBaseSystemPrompt(supabase) {
  // Prompt global appliqué à TOUS les agents.
  // Géré via /admin/settings (table app_settings, key=base_system_prompt)
  try {
    const { data, error } = await supabase
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method Not Allowed" });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(res, 500, {
        error: "Supabase server env manquantes",
        detail: {
          SUPABASE_URL: !!SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY,
        },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json(res, 401, { error: "Missing bearer token" });

    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return json(res, 401, { error: "Invalid token", detail: authErr?.message || null });
    }

    const user = authData.user;
    const { agentSlug, conversationId, message } = req.body || {};

    if (!agentSlug || typeof agentSlug !== "string") {
      return json(res, 400, { error: "agentSlug manquant" });
    }
    if (!message || typeof message !== "string" || !message.trim()) {
      return json(res, 400, { error: "message manquant" });
    }

    // A) Charger l'agent + verifier droit (user_agents)
    const { data: agentRow, error: agentErr } = await supabase
      .from("agents")
      .select("id, slug, name")
      .eq("slug", agentSlug)
      .maybeSingle();

    if (agentErr) throw new Error(`Supabase agents select error: ${agentErr.message}`);
    if (!agentRow) return json(res, 404, { error: "Agent introuvable" });

    const { data: uaRow, error: uaErr } = await supabase
      .from("user_agents")
      .select("id")
      .eq("user_id", user.id)
      .eq("agent_id", agentRow.id)
      .maybeSingle();

    if (uaErr) throw new Error(`Supabase user_agents select error: ${uaErr.message}`);
    if (!uaRow) return json(res, 403, { error: "Acces refuse a cet agent" });

    // B) Conversation
    let convId = conversationId || null;

    if (convId) {
      const { data: conv, error: convErr } = await supabase
        .from("conversations")
        .select("id, user_id, agent_slug")
        .eq("id", convId)
        .maybeSingle();

      if (convErr) throw new Error(`Supabase conversations select error: ${convErr.message}`);
      if (!conv || conv.user_id !== user.id || conv.agent_slug !== agentSlug) {
        return json(res, 403, { error: "Conversation non autorisee" });
      }
    } else {
      const title = message.trim().slice(0, 60);
      const { data: convIns, error: convInsErr } = await supabase
        .from("conversations")
        .insert({
          user_id: user.id,
          agent_slug: agentSlug,
          title,
          archived: false,
        })
        .select("id")
        .single();

      if (convInsErr) throw new Error(`Supabase conversations insert error: ${convInsErr.message}`);
      convId = convIns.id;
    }

    // C) Charger config agent user (system_prompt + context)
    let systemPrompt = "";
    let context = {};

    const { data: cfgRow, error: cfgErr } = await supabase
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", user.id)
      .eq("agent_id", agentRow.id)
      .maybeSingle();

    if (cfgErr) throw new Error(`Supabase client_agent_configs select error: ${cfgErr.message}`);

    if (cfgRow?.system_prompt) systemPrompt = cfgRow.system_prompt;
    if (cfgRow?.context && typeof cfgRow.context === "object") context = cfgRow.context;

    // Prompt global (applique a tous les agents)
    const baseSystemPrompt = await loadBaseSystemPrompt(supabase);

    // D) Historique (dernier 20 messages user/assistant)
    const { data: histRows, error: histErr } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", convId)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(20);

    if (histErr) throw new Error(`Supabase messages history error: ${histErr.message}`);

    const history = (histRows || []).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // E) Insert message user
    const { error: insUserErr } = await supabase.from("messages").insert({
      conversation_id: convId,
      role: "user",
      content: message,
    });

    if (insUserErr) throw new Error(`Supabase insert user message error: ${insUserErr.message}`);

    // F) Charger sources (CSV) et enrichir le system prompt
    const sourcesBlock = await buildSourcesContext({
      supabase,
      context,
      userMessage: message,
    });

    const finalSystemPrompt = [baseSystemPrompt, systemPrompt, sourcesBlock]
      .filter((x) => safeStr(x).trim().length > 0)
      .join("\n\n")
      .trim();

    // G) Appel Mistral
    const reply = await callMistral({
      systemPrompt: finalSystemPrompt,
      history,
      userMessage: message,
    });

    // H) Insert message assistant
    const { error: insAsstErr } = await supabase.from("messages").insert({
      conversation_id: convId,
      role: "assistant",
      content: reply,
    });

    if (insAsstErr) throw new Error(`Supabase insert assistant message error: ${insAsstErr.message}`);

    return json(res, 200, { ok: true, conversationId: convId, reply });
  } catch (err) {
    console.error("/api/chat error:", err);

    return json(res, 500, {
      error: "Internal Server Error",
      message: err?.message || String(err),
      code: err?.code || null,
      status: err?.status || null,
      detail: err?.detail || null,
    });
  }
}
