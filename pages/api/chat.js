import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

const BUILD_TAG = "API_CHAT_FIX_MAKE_AND_PARAGRAPHS_2026_01_22";

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
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } 
        else { inQuotes = !inQuotes; }
        continue;
      }
      if (!inQuotes && ch === delimiter) { out.push(cur); cur = ""; continue; }
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
    for (let j = 0; j < headers.length; j++) { obj[headers[j]] = values[j] ?? ""; }
    rows.push(obj);
  }
  return { headers, rows };
}

function rowToSearchableString(row) {
  try { return normalizeText(Object.values(row || {}).join(" ")); } catch { return ""; }
}

function extractQueryTokens(userMessage) {
  const msg = normalizeText(userMessage);
  const tokens = msg.split(" ").filter(Boolean);
  const stop = new Set(["le","la","les","un","une","des","du","de","d","et","ou","a","à","au","aux","pour","par","sur","dans","avec","sans","stp","svp","merci","bonjour","salut","peux","tu","me","donner","liste","lister","mails","mail","emails","email","societe","société","entreprise","contact","contacts"]);
  return tokens.filter((t) => t.length >= 2 && !stop.has(t));
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
  return data.text ? await data.text() : Buffer.from(await data.arrayBuffer()).toString("utf-8");
}

function buildSourceContextBlock({ fileName, headers, sampleRows, warning }) {
  const lines = [`SOURCE CSV: ${fileName}`];
  if (headers?.length) lines.push(`Colonnes: ${headers.join(", ")}`);
  if (warning) lines.push(`Note: ${warning}`);
  if (!sampleRows || sampleRows.length === 0) {
    lines.push("Aucune ligne pertinente trouvée.");
    return lines.join("\n");
  }
  lines.push("Lignes pertinentes (extrait):");
  for (const r of sampleRows) {
    lines.push("- " + Object.entries(r).slice(0, 12).map(([k, v]) => `${k}=${String(v || "").trim()}`).join(" | "));
  }
  return safeTruncate(lines.join("\n"), 8000);
}

async function buildSourcesContext({ supabase, context, userMessage }) {
  const sources = context?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return "";
  const blocks = [];
  for (const src of sources) {
    const path = src?.path || "";
    if (!path.toLowerCase().endsWith(".csv")) continue;
    try {
      const text = await downloadTextFromStorage(supabase, src?.bucket || "agent_sources", path);
      const { headers, rows } = parseCsv(text);
      const relevant = topRelevantRows(rows, userMessage, 20);
      blocks.push(buildSourceContextBlock({ fileName: src?.name || path, headers, sampleRows: relevant }));
    } catch (e) { console.error(e); }
  }
  return blocks.length ? `\n\n${blocks.join("\n\n---\n\n")}` : "";
}

async function loadBaseSystemPrompt(supabase) {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "base_system_prompt").maybeSingle();
  return String(data?.value || "").trim();
}

async function callMistral({ systemPrompt, history, userMessage }) {
  // AJOUT : Instruction forcée pour les paragraphes
  const styleInstruction = "\n\nIMPORTANT: Pour les emails, sépare TOUJOURS tes paragraphes par une ligne vide (\\n\\n). Ne fais pas de bloc compact.";
  
  const messages = [
    { role: "system", content: systemPrompt + styleInstruction },
    ...history,
    { role: "user", content: userMessage },
  ];

  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${MISTRAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mistral-small-latest", messages, temperature: 0.2 }),
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content;
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

    await supabase.from("messages").insert({ conversation_id: convId, role: "user", content: message });

    // AJOUT : Chargement de l'historique pour l'envoi Make
    const { data: historyData } = await supabase.from("messages").select("role, content").eq("conversation_id", convId).order("created_at", { ascending: false }).limit(6);
    const history = (historyData || []).reverse().map(m => ({ role: m.role, content: m.content }));

    const { data: cfg } = await supabase.from("client_agent_configs").select("system_prompt, context").eq("user_id", auth.user.id).eq("agent_id", agent.id).maybeSingle();
    const basePrompt = await loadBaseSystemPrompt(supabase);
    
    const sourcesContext = await buildSourcesContext({ supabase, context: cfg?.context, userMessage: message });
    const finalSystemPrompt = [basePrompt, agent.default_system_prompt, cfg?.system_prompt, sourcesContext].filter(Boolean).join("\n\n");

    const reply = await callMistral({ systemPrompt: finalSystemPrompt, history, userMessage: message });

    // AJOUT : Déclenchement Make si "ok envoie"
    const cmd = normalizeText(message);
    if ((cmd === "ok envoie" || cmd === "envoie le mail") && history.length > 0) {
      const lastDraft = [...history].reverse().find(m => m.role === "assistant" && m.content.includes("{"));
      if (lastDraft) {
        const match = lastDraft.content.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            let emailData = JSON.parse(match[0]);
            // On s'assure que le corps du mail conserve ses paragraphes pour Make
            emailData.body = emailData.body.replace(/\\n/g, "\n"); 
            await fetch(process.env.MAKE_WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(emailData)
            });
          } catch (e) { console.error("Make Error:", e); }
        }
      }
    }

    await supabase.from("messages").insert({ conversation_id: convId, role: "assistant", content: reply });

    return json(res, 200, { ok: true, conversationId: convId, reply, buildTag: BUILD_TAG });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
