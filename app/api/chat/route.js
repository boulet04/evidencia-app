import { createClient } from "@supabase/supabase-js";
import pdfParse from "pdf-parse";

/**
 * Next.js App Router API route: /api/chat
 * Fixes 405 by providing POST handler.
 * Keeps behavior compatible with the existing client payload:
 * { agentSlug, conversationId, message }
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

function json(res, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function getBearerToken(req) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function supabaseAdmin() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function extractFileText(sb, bucket, path, mime) {
  // Best-effort extraction (CSV/TXT/MD/JSON/PDF)
  const { data, error } = await sb.storage.from(bucket).download(path);
  if (error || !data) return "";

  const ab = await data.arrayBuffer();
  const buf = Buffer.from(ab);

  const m = safeStr(mime).toLowerCase();
  if (m.includes("pdf")) {
    try {
      const parsed = await pdfParse(buf);
      return safeStr(parsed?.text || "").trim();
    } catch {
      return "";
    }
  }

  // text-ish
  if (
    m.startsWith("text/") ||
    m.includes("csv") ||
    m.includes("json") ||
    m.includes("markdown")
  ) {
    // Cap size to avoid huge prompts
    const text = buf.toString("utf8");
    return text.slice(0, 20000);
  }

  // xlsx/ppt/docx etc: not handled here (can be added later)
  return "";
}

async function buildSourcesContext(sb, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return "";

  const bucket = "agent_sources";
  let out = "SOURCES FOURNIES (extraits):\n";
  let any = false;

  for (const s of sources) {
    const type = safeStr(s?.type).toLowerCase();

    // URLs can be stored as {type:"url", url:"..."} or {type:"url", value:"..."}
    const url = safeStr(s?.value || s?.url).trim();
    if (type === "url" && url) {
      any = true;
      out += `\n- URL: ${url}\n`;
      continue;
    }

    // Files: expect {type:"file", path:"...", name:"...", mime:"..."} (or storage_path)
    const p = safeStr(s?.path || s?.storage_path).trim();
    const name = safeStr(s?.name || s?.filename || p.split("/").pop()).trim();
    const mime = safeStr(s?.mime || s?.contentType).trim();

    if (type === "file" && p) {
      const text = await extractFileText(sb, bucket, p, mime);
      any = true;
      if (text) {
        out += `\n- Fichier: ${name}\n${text.slice(0, 4000)}\n`;
      } else {
        out += `\n- Fichier: ${name} (contenu non extrait)\n`;
      }
    }
  }

  return any ? out.trim() : "";
}

async function callMistral(messages, model) {
  if (!MISTRAL_API_KEY) throw new Error("Missing MISTRAL_API_KEY env var");
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || "mistral-large-latest",
      messages,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Mistral error ${res.status}: ${t.slice(0, 400)}`);
  }
  const json = await res.json();
  return safeStr(json?.choices?.[0]?.message?.content || "").trim();
}

async function getBasePrompt(sb) {
  // Best effort: app_settings(key='base_prompt') then global_prompts(name='base_prompt')
  try {
    const a = await sb.from("app_settings").select("value").eq("key", "base_prompt").maybeSingle();
    if (a?.data?.value) return safeStr(a.data.value);
  } catch {}
  try {
    const g = await sb.from("global_prompts").select("content").eq("name", "base_prompt").maybeSingle();
    if (g?.data?.content) return safeStr(g.data.content);
  } catch {}
  return "";
}

async function getAgentSystem(sb, userId, agentSlug) {
  // Best effort order: client_agent_configs then agents
  let systemPrompt = "";
  let sources = [];
  try {
    const cfg = await sb
      .from("client_agent_configs")
      .select("system_prompt,sources,workflows,prompt")
      .eq("user_id", userId)
      .eq("agent_slug", agentSlug)
      .maybeSingle();
    if (cfg?.data) {
      systemPrompt = safeStr(cfg.data.system_prompt || cfg.data.prompt);
      if (Array.isArray(cfg.data.sources)) sources = cfg.data.sources;
      return { systemPrompt, sources, model: "" };
    }
  } catch {}

  try {
    const ag = await sb.from("agents").select("system_prompt,model").eq("slug", agentSlug).maybeSingle();
    if (ag?.data) {
      systemPrompt = safeStr(ag.data.system_prompt);
      return { systemPrompt, sources, model: safeStr(ag.data.model) };
    }
  } catch {}

  return { systemPrompt, sources, model: "" };
}

async function getHistory(sb, userId, conversationId) {
  // messages table: {conversation_id, user_id, role, content, created_at}
  try {
    const { data } = await sb
      .from("messages")
      .select("role,content,created_at")
      .eq("conversation_id", conversationId)
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(30);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function persistPair(sb, userId, conversationId, userMsg, assistantMsg) {
  try {
    await sb.from("messages").insert([
      { conversation_id: conversationId, user_id: userId, role: "user", content: userMsg },
      { conversation_id: conversationId, user_id: userId, role: "assistant", content: assistantMsg },
    ]);
  } catch {
    // non bloquant
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
    },
  });
}

export async function POST(req) {
  try {
    const sb = supabaseAdmin();

    const token = getBearerToken(req);
    if (!token) return json(req, 401, { error: "Missing Bearer token" });

    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user?.id) {
      return json(req, 401, { error: "Invalid session" });
    }
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const agentSlug = safeStr(body?.agentSlug).trim();
    const conversationId = safeStr(body?.conversationId).trim();
    const message = safeStr(body?.message).trim();

    if (!agentSlug || !conversationId || !message) {
      return json(req, 400, { error: "Missing agentSlug, conversationId or message" });
    }

    const basePrompt = await getBasePrompt(sb);
    const { systemPrompt, sources, model } = await getAgentSystem(sb, userId, agentSlug);
    const sourcesCtx = await buildSourcesContext(sb, sources);

    const history = await getHistory(sb, userId, conversationId);

    const systemParts = [];
    if (basePrompt) systemParts.push(basePrompt);
    if (systemPrompt) systemParts.push(systemPrompt);
    if (sourcesCtx) systemParts.push(sourcesCtx);

    const messages = [{ role: "system", content: systemParts.join("\n\n").trim() || "Tu es un assistant utile." }];

    for (const h of history) {
      const r = safeStr(h?.role).toLowerCase();
      if (r === "system") continue;
      const c = safeStr(h?.content).trim();
      if (!c) continue;
      messages.push({ role: r === "assistant" ? "assistant" : "user", content: c });
    }

    messages.push({ role: "user", content: message });

    const reply = await callMistral(messages, model);

    await persistPair(sb, userId, conversationId, message, reply);

    return json(req, 200, { reply });
  } catch (e) {
    return json(req, 500, { error: safeStr(e?.message || e) });
  }
}

// Optional: allow GET for quick health check
export async function GET() {
  return json(null, 200, { ok: true, route: "/api/chat" });
}
