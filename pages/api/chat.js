import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

const BUILD_TAG = "STABLE_V4_MAKE_PARAGRAPHS";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// --- LOGIQUE DE RECHERCHE CSV (VOTRE CODE INITIAL) ---
function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/[\u2019']/g, "'").replace(/[^a-z0-9àâäéèêëïîôöùûüç@._ \-]+/gi, " ").replace(/\s+/g, " ").trim();
}

function parseCsv(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n").filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const sep = lines[0].includes(";") ? ";" : (lines[0].includes("\t") ? "\t" : ",");
  const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map(line => {
    const vals = line.split(sep).map(v => v.trim().replace(/^"|"$/g, ''));
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
  const query = normalizeText(userMessage);
  
  for (const src of sources) {
    if (!src.path?.toLowerCase().endsWith(".csv")) continue;
    try {
      const { data } = await supabase.storage.from(src.bucket || "agent_sources").download(src.path);
      const { rows } = parseCsv(await data.text());
      const relevant = rows.filter(r => Object.values(r).some(v => normalizeText(v).includes(query))).slice(0, 5);
      if (relevant.length) {
        blocks.push(`SOURCE ${src.name}:\n${JSON.stringify(relevant)}`);
      }
    } catch (e) { console.error("CSV Error", e); }
  }
  return blocks.length ? "\n\nCONTACTS TROUVÉS:\n" + blocks.join("\n") : "";
}

// --- HANDLER PRINCIPAL ---
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

    // Charger l'historique (10 derniers messages)
    const { data: historyData } = await supabase.from("messages").select("role, content").eq("conversation_id", convId).order("created_at", { ascending: false }).limit(10);
    const history = (historyData || []).reverse();

    // --- DETECTION "OK ENVOIE" ---
    const userText = normalizeText(message);
    if (userText === "ok envoie" || userText === "envoie") {
      const lastAssistantMsg = [...history].reverse().find(m => m.role === "assistant" && m.content.includes("{"));
      if (lastAssistantMsg) {
        const jsonMatch = lastAssistantMsg.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const emailData = JSON.parse(jsonMatch[0]);
          emailData.body = emailData.body.replace(/\\n/g, "\n"); // Réparer les paragraphes pour l'envoi
          
          await fetch(process.env.MAKE_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(emailData)
          });

          const confirmation = "C'est fait, l'email a été envoyé via Make !";
          await supabase.from("messages").insert([
            { conversation_id: convId, role: "user", content: message },
            { conversation_id: convId, role: "assistant", content: confirmation }
          ]);
          return json(res, 200, { ok: true, reply: confirmation });
        }
      }
    }

    // --- RÉPONSE CLASSIQUE MISTRAL ---
    const { data: cfg } = await supabase.from("client_agent_configs").select("*").eq("user_id", auth.user.id).eq("agent_id", agent.id).maybeSingle();
    const { data: glob } = await supabase.from("app_settings").select("value").eq("key", "base_system_prompt").maybeSingle();
    
    const sourcesCtx = await buildSourcesContext({ supabase, context: cfg?.context, userMessage: message });
    
    // Instruction de style ultra-stricte pour les paragraphes
    const stylePrompt = "\n\nIMPORTANT STYLE: Sépare toujours tes paragraphes par une ligne vide. Ne fais JAMAIS de bloc de texte compact.";
    
    const finalSystemPrompt = [glob?.value, agent.default_system_prompt, cfg?.system_prompt, sourcesCtx].filter(Boolean).join("\n\n") + stylePrompt;

    const mistralRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${MISTRAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: [{ role: "system", content: finalSystemPrompt }, ...history, { role: "user", content: message }],
        temperature: 0.2
      }),
    });

    const mistralData = await mistralRes.json();
    const reply = mistralData.choices[0].message.content;

    await supabase.from("messages").insert([
      { conversation_id: convId, role: "user", content: message },
      { conversation_id: convId, role: "assistant", content: reply }
    ]);

    return json(res, 200, { ok: true, conversationId: convId, reply });

  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
