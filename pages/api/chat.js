// pages/api/chat.js
// API Next.js (pages router) :
// - verifie le token Supabase de l'utilisateur
// - cree/valide la conversation
// - insere le message user
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
    const err = new Error("Reponse Mistral inattendue (choices[0].message.content manquant)." );
    err.code = "MISTRAL_BAD_RESPONSE";
    err.detail = data;
    throw err;
  }

  return reply;
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

    // 1) Conversation
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

    // 2) Prompt agent (fallback si table/row absente)
    let systemPrompt = "";
    try {
      const { data: cfg, error: cfgErr } = await supabase
        .from("agent_configs")
        .select("base_prompt")
        .eq("user_id", user.id)
        .eq("agent_slug", agentSlug)
        .maybeSingle();

      if (!cfgErr && cfg?.base_prompt) systemPrompt = cfg.base_prompt;
    } catch {
      // si la table agent_configs n'existe pas dans ton schéma actuel, on ignore.
    }

    // 3) Historique (dernier 20 messages user/assistant)
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

    // 4) Insert message user
    const { error: insUserErr } = await supabase
      .from("messages")
      .insert({
        conversation_id: convId,
        role: "user",
        content: message,
      });

    if (insUserErr) throw new Error(`Supabase insert user message error: ${insUserErr.message}`);

    // 5) Appel Mistral
    const reply = await callMistral({ systemPrompt, history, userMessage: message });

    // 6) Insert message assistant
    const { error: insAsstErr } = await supabase
      .from("messages")
      .insert({
        conversation_id: convId,
        role: "assistant",
        content: reply,
      });

    if (insAsstErr) throw new Error(`Supabase insert assistant message error: ${insAsstErr.message}`);

    return json(res, 200, { ok: true, conversationId: convId, reply });
  } catch (err) {
    // Logs Vercel (Project -> Functions -> api/chat -> Logs)
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
