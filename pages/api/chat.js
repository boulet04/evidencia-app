// pages/api/chat.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

const BUILD_TAG = "API_CHAT_MAKE_JSON_PARAGRAPHS_2026_01_22";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function normalizeText(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// --- PARSER CSV AMÉLIORÉ ---
function parseCsv(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n").filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const sep = lines[0].includes(";") ? ";" : (lines[0].includes("\t") ? "\t" : ",");
  const parseL = (l) => l.split(sep).map(v => v.replace(/^"|"$/g, '').trim());
  const headers = parseL(lines[0]);
  const rows = lines.slice(1).map(line => {
    const vals = parseL(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    return obj;
  });
  return { headers, rows };
}

async function buildSourcesContext({ supabase, context, userMessage }) {
  const sources = context?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return "";
  let blocks = [];
  const tokens = userMessage.toLowerCase().split(" ").filter(t => t.length > 2);

  for (const src of sources) {
    if (!src.path?.toLowerCase().endsWith(".csv")) continue;
    try {
      const { data } = await supabase.storage.from(src.bucket || "agent_sources").download(src.path);
      const text = await data.text();
      const { headers, rows } = parseCsv(text);
      
      // Recherche intelligente dans le CSV
      const relevant = rows.filter(r => {
        const rowStr = Object.values(r).join(" ").toLowerCase();
        return tokens.some(t => rowStr.includes(t));
      }).slice(0, 10);

      blocks.push(`FICHIER: ${src.name}\nCOLONNES: ${headers.join(", ")}\nDONNÉES: ${relevant.length ? JSON.stringify(relevant) : "Aucune ligne trouvée"}`);
    } catch (e) { console.error("CSV Error", e); }
  }
  return blocks.length ? "\n\nSOURCES DISPONIBLES:\n" + blocks.join("\n\n") : "";
}

async function callMistral({ systemPrompt, history, userMessage }) {
  // On force Mistral à respecter les paragraphes même dans le JSON
  const formattingInstruction = "\n\nIMPORTANT: Pour les emails, utilise impérativement des doubles sauts de ligne (\\n\\n) entre chaque paragraphe pour que le texte soit aéré et lisible.";
  
  const messages = [
    { role: "system", content: systemPrompt + formattingInstruction },
    ...history,
    { role: "user", content: userMessage },
  ];

  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${MISTRAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mistral-small-latest", messages, temperature: 0.2 }),
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || "Erreur de réponse.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const { data: auth } = await supabase.auth.getUser(token);
    if (!auth?.user) return json(res, 401, { error: "Unauthorized" });

    const { agentSlug, conversationId, message } = req.body;
    const { data: agent } = await supabase.from("agents").select("*").eq("slug", agentSlug).single();

    let convId = conversationId;
    if (!convId) {
      const { data } = await supabase.from("conversations").insert({ user_id: auth.user.id, agent_slug: agentSlug }).select("id").single();
      convId = data.id;
    }

    await supabase.from("messages").insert({ conversation_id: convId, role: "user", content: message });

    const { data: historyData } = await supabase.from("messages").select("role, content").eq("conversation_id", convId).order("created_at", { ascending: false }).limit(8);
    const history = (historyData || []).reverse().map(m => ({ role: m.role, content: m.content }));

    const { data: cfg } = await supabase.from("client_agent_configs").select("*").eq("user_id", auth.user.id).eq("agent_id", agent.id).maybeSingle();
    const { data: glob } = await supabase.from("app_settings").select("value").eq("key", "base_system_prompt").maybeSingle();

    const sourcesContext = await buildSourcesContext({ supabase, context: cfg?.context, userMessage: message });

    const finalSystemPrompt = [
      glob?.value,
      agent.default_system_prompt,
      cfg?.system_prompt,
      sourcesContext
    ].filter(Boolean).join("\n\n---\n\n");

    const reply = await callMistral({ systemPrompt: finalSystemPrompt, history, userMessage: message });

    // --- LOGIQUE D'ENVOI MAKE ---
    // Si l'utilisateur dit "ok envoie" et que la réponse contient un JSON
    if (normalizeText(message) === "ok envoie" && reply.includes("{") && reply.includes("}")) {
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const emailData = JSON.parse(jsonMatch[0]);
                // Appel au Webhook Make (remplacez par votre URL si nécessaire ou laissez l'IA le gérer)
                await fetch(process.env.MAKE_WEBHOOK_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(emailData)
                });
            }
        } catch (e) { console.error("Make trigger failed", e); }
    }

    await supabase.from("messages").insert({ conversation_id: convId, role: "assistant", content: reply });

    return json(res, 200, { ok: true, conversationId: convId, reply, buildTag: BUILD_TAG });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
