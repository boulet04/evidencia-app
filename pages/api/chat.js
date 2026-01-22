// pages/api/chat.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

const BUILD_TAG = "API_CHAT_FIX_CSV_SEARCH_V2_2026_01_22";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Enlève les accents
    .replace(/[^a-z0-9@._ \-]+/gi, " ")
    .trim();
}

function pickDelimiter(sampleLine) {
  const semi = (sampleLine.match(/;/g) || []).length;
  const comma = (sampleLine.match(/,/g) || []).length;
  const tab = (sampleLine.match(/\t/g) || []).length;
  if (tab >= semi && tab >= comma && tab > 0) return "\t";
  if (semi >= comma && semi > 0) return ";";
  return ",";
}

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
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (!inQuotes && ch === delimiter) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(v => v.trim());
  };

  const headers = parseLine(lines[0]).map((h, i) => h || `col_${i+1}`);
  const rows = lines.slice(1).map(line => {
    const values = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ""; });
    return obj;
  });
  return { headers, rows };
}

function extractQueryTokens(userMessage) {
  const msg = normalizeText(userMessage);
  const stop = new Set(["le","la","les","un","une","des","pour","dans","avec","chercher","trouve","donne","moi"]);
  return msg.split(" ").filter(t => t.length >= 2 && !stop.has(t));
}

function topRelevantRows(rows, userMessage, maxRows = 25) {
  const tokens = extractQueryTokens(userMessage);
  if (tokens.length === 0) return rows.slice(0, 5); // Fallback data

  return rows
    .map(r => {
      const rowStr = normalizeText(Object.values(r).join(" "));
      let score = 0;
      tokens.forEach(t => { if (rowStr.includes(t)) score += 1; });
      return { row: r, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRows)
    .map(x => x.row);
}

async function downloadTextFromStorage(supabase, bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`Download failed: ${error?.message}`);
  return data.text ? await data.text() : Buffer.from(await data.arrayBuffer()).toString("utf-8");
}

async function buildSourcesContext({ supabase, context, userMessage }) {
  const sources = context?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return "";
  const blocks = [];

  for (const src of sources) {
    if (!src.path || !src.path.toLowerCase().endsWith(".csv")) continue;
    try {
      const text = await downloadTextFromStorage(supabase, src.bucket || "agent_sources", src.path);
      const { headers, rows } = parseCsv(text);
      const relevant = topRelevantRows(rows, userMessage);
      
      let block = `FICHIER SOURCE: ${src.name}\nCOLONNES: ${headers.join(", ")}\n`;
      if (relevant.length > 0) {
        block += "DONNÉES TROUVÉES:\n" + relevant.map(r => JSON.stringify(r)).join("\n");
      } else {
        block += "NOTE: Aucun résultat exact pour cette recherche dans ce fichier.";
      }
      blocks.push(block);
    } catch (e) { console.error("Source error:", e); }
  }
  return blocks.length ? "\n\nCONTEXTE DES FICHIERS:\n" + blocks.join("\n\n") : "";
}

async function callMistral({ systemPrompt, history, userMessage }) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];
  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${MISTRAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mistral-small-latest", messages, temperature: 0.1 }),
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || "Désolé, je rencontre une difficulté technique.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const { data: auth } = await supabase.auth.getUser(token);
    if (!auth?.user) return json(res, 401, { error: "Unauthorized" });

    const { agentSlug, conversationId, message } = req.body;
    const { data: agent } = await supabase.from("agents").select("id, default_system_prompt").eq("slug", agentSlug).single();

    let convId = conversationId;
    if (!convId) {
      const { data } = await supabase.from("conversations").insert({ user_id: auth.user.id, agent_slug: agentSlug }).select("id").single();
      convId = data.id;
    }

    // Sauvegarder message utilisateur
    await supabase.from("messages").insert({ conversation_id: convId, role: "user", content: message });

    // Charger historique récent (10 derniers messages)
    const { data: historyData } = await supabase.from("messages").select("role, content").eq("conversation_id", convId).order("created_at", { ascending: false }).limit(10);
    const history = (historyData || []).reverse().map(m => ({ role: m.role, content: m.content }));

    // Charger config agent
    const { data: cfg } = await supabase.from("client_agent_configs").select("system_prompt, context").eq("user_id", auth.user.id).eq("agent_id", agent.id).maybeSingle();
    
    // Charger prompt global
    const { data: glob } = await supabase.from("app_settings").select("value").eq("key", "base_system_prompt").maybeSingle();

    const sourcesText = await buildSourcesContext({ supabase, context: cfg?.context, userMessage: message });
    
    const finalSystemPrompt = [
      glob?.value,
      agent.default_system_prompt,
      cfg?.system_prompt,
      sourcesText
    ].filter(Boolean).join("\n\n");

    const reply = await callMistral({ systemPrompt: finalSystemPrompt, history, userMessage: message });

    // Sauvegarder réponse assistant
    await supabase.from("messages").insert({ conversation_id: convId, role: "assistant", content: reply });

    return json(res, 200, { ok: true, conversationId: convId, reply, buildTag: BUILD_TAG });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
