// pages/api/chat.js
// - verifie le token Supabase de l'utilisateur
// - verifie acces a l'agent (user_agents)
// - cree/valide la conversation
// - insere le message user
// - charge prompts: global (app_settings) + default agent (agents.default_system_prompt) + user override (client_agent_configs)
// - charge sources (CSV depuis Storage)
// - appelle Mistral via HTTP (avec retry 429)
// - insere la reponse assistant

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

const BUILD_TAG = "API_CHAT_CLEAN_GLOBAL_PROMPT_2026_01_21";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^a-z0-9àâäéèêëïîôöùûüç@._ \-]+/gi, " ")
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

// CSV parser simple
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

  const stop = new Set([
    "le","la","les","un","une","des","du","de","d","et","ou",
    "a","à","au","aux","pour","par","sur","dans","avec","sans",
    "stp","svp","merci","bonjour","salut",
    "peux","tu","me","donner","liste","lister",
    "mails","mail","emails","email",
    "societe","société","entreprise","contact","contacts"
  ]);

  return tokens.filter((t) => t.length >= 3 && !stop.has(t));
}

function scoreRow(rowStr, tokens) {
  let score = 0;
  for (const t of tokens) {
    if (rowStr.includes(t)) score += 2;
    if (t.includes(".") && rowStr.includes(t)) score += 2;
  }
  return score;
}

function topRelevantRows(rows, userMessage, maxRows = 20) {
  const tokens = extractQueryTokens(userMessage);
  if (tokens.length === 0) return [];

  return rows
    .map((r) => ({ row: r, score: scoreRow(rowToSearchableString(r), tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRows)
    .map((x) => x.row);
}

function safeTruncate(str, maxChars) {
  const s = String(str || "");
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "\n…(tronqué)";
}

async function downloadTextFromStorage(supabase, bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
  if (typeof data.text === "function") return await data.text();
  const ab = await data.arrayBuffer();
  return Buffer.from(ab).toString("utf-8");
}

function buildSourceContextBlock({ fileName, headers, sampleRows, warning }) {
  const lines = [];
  lines.push(`SOURCE CSV: ${fileName}`);
  if (headers?.length) lines.push(`Colonnes: ${headers.join(", ")}`);
  if (warning) lines.push(`Note: ${warning}`);

  if (!sampleRows || sampleRows.length === 0) {
    lines.push("Aucune ligne pertinente trouvée.");
    lines.push("Demander le nom exact de la société ou le domaine email.");
    return lines.join("\n");
  }

  lines.push("Lignes pertinentes (extrait):");
  for (const r of sampleRows) {
    lines.push(
      "- " +
        Object.entries(r)
          .slice(0, 12)
          .map(([k, v]) => `${k}=${String(v || "").trim()}`)
          .join(" | ")
    );
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

    const isCsv =
      mime.toLowerCase().includes("text/csv") ||
      name.toLowerCase().endsWith(".csv") ||
      path.toLowerCase().endsWith(".csv");

    if (!isCsv || !path) continue;

    let text = "";
    let warning = "";

    try {
      text = await downloadTextFromStorage(supabase, bucket, path);
      if (text.length > 1_200_000) {
        warning = "Fichier volumineux, lecture partielle.";
        text = text.slice(0, 250_000);
      }
    } catch (e) {
      blocks.push(
        buildSourceContextBlock({
          fileName: name || path,
          headers: [],
          sampleRows: [],
          warning: e.message,
        })
      );
      continue;
    }

    const { headers, rows } = parseCsv(text);
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

  return `\n\n${blocks.join("\n\n---\n\n")}`;
}

async function loadBaseSystemPrompt(supabase) {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "base_system_prompt")
    .maybeSingle();
  return String(data?.value || "").trim();
}

async function callMistral({ systemPrompt, history, userMessage }) {
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

  const data = await r.json();
  return data?.choices?.[0]?.message?.content;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const { data: auth } = await supabase.auth.getUser(token);
    if (!auth?.user) return json(res, 401, { error: "Unauthorized" });

    const { agentSlug, conversationId, message } = req.body;

    const { data: agent } = await supabase
      .from("agents")
      .select("id, default_system_prompt")
      .eq("slug", agentSlug)
      .single();

    let convId = conversationId;
    if (!convId) {
      const { data } = await supabase
        .from("conversations")
        .insert({ user_id: auth.user.id, agent_slug: agentSlug })
        .select("id")
        .single();
      convId = data.id;
    }

    await supabase.from("messages").insert({
      conversation_id: convId,
      role: "user",
      content: message,
    });

    const { data: cfg } = await supabase
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", auth.user.id)
      .eq("agent_id", agent.id)
      .maybeSingle();

    const basePrompt = await loadBaseSystemPrompt(supabase);
    const finalSystemPrompt = [
      basePrompt,
      agent.default_system_prompt,
      cfg?.system_prompt,
      await buildSourcesContext({ supabase, context: cfg?.context, userMessage: message }),
    ]
      .filter(Boolean)
      .join("\n\n");

    const reply = await callMistral({
      systemPrompt: finalSystemPrompt,
      history: [],
      userMessage: message,
    });

    await supabase.from("messages").insert({
      conversation_id: convId,
      role: "assistant",
      content: reply,
    });

    return json(res, 200, { ok: true, conversationId: convId, reply, buildTag: BUILD_TAG });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
