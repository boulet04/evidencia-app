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
      const s = rowToSearchable
