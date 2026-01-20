// pages/api/chat.js
import supabaseAdmin from "../../lib/supabaseAdmin";
import agentPromptsImport from "../../lib/agentPrompts";
import { Mistral } from "@mistralai/mistralai";

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const parts = h.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  return null;
}

function toPromptMap(mod) {
  // support default export or named export
  return mod?.default || mod || {};
}

async function fetchUserGlobalPrompt({ userId }) {
  // 1) user_global_prompts (prioritaire)
  const { data: ugp, error: ugpErr } = await supabaseAdmin
    .from("user_global_prompts")
    .select("global_prompt")
    .eq("user_id", userId)
    .maybeSingle();

  if (!ugpErr) {
    const txt = (ugp?.global_prompt || "").trim();
    if (txt) return txt;
  }

  // 2) legacy: client_agent_configs + agents.slug = '_global_'
  const { data: legacy, error: legacyErr } = await supabaseAdmin
    .from("client_agent_configs")
    .select("system_prompt, agents!inner(slug)")
    .eq("user_id", userId)
    .eq("agents.slug", "_global_")
    .maybeSingle();

  if (!legacyErr) {
    const txt = (legacy?.system_prompt || "").trim();
    if (txt) return txt;
  }

  // 3) défaut: global_prompts (key = GLOBAL_SYSTEM_PROMPT)
  const { data: gp, error: gpErr } = await supabaseAdmin
    .from("global_prompts")
    .select("content")
    .eq("key", "GLOBAL_SYSTEM_PROMPT")
    .maybeSingle();

  if (!gpErr) {
    const txt = (gp?.content || "").trim();
    if (txt) return txt;
  }

  return "";
}

async function fetchAgentSystemPrompt({ userId, agentId, agentSlug }) {
  // prompt personnalisé user/agent
  const { data: cfg, error: cfgErr } = await supabaseAdmin
    .from("client_agent_configs")
    .select("system_prompt, context")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .maybeSingle();

  if (!cfgErr) {
    const txt = (cfg?.system_prompt || "").trim();
    if (txt) return { systemPrompt: txt, context: cfg?.context || null };
  }

  // fallback lib/agentPrompts
  const promptMap = toPromptMap(agentPromptsImport);
  const fallback =
    (promptMap && typeof promptMap === "object" && (promptMap[agentSlug] || promptMap[`${agentSlug}`])) ||
    promptMap?.DEFAULT ||
    promptMap?.default ||
    "";

  return { systemPrompt: (fallback || "").trim(), context: null };
}

async function fetchConversationMessages(conversationId, limit = 30) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return [];
  const list = Array.isArray(data) ? data : [];
  return list
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
    }))
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Missing Bearer token" });

    const { data: authData, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !authData?.user) return res.status(401).json({ error: "Invalid token" });

    const userId = authData.user.id;

    const { conversation_id, agent_slug, message } = req.body || {};
    if (!conversation_id || typeof conversation_id !== "string") {
      return res.status(400).json({ error: "Missing conversation_id" });
    }
    if (!agent_slug || typeof agent_slug !== "string") {
      return res.status(400).json({ error: "Missing agent_slug" });
    }
    const userMessage = (typeof message === "string" ? message : "").trim();
    if (!userMessage) return res.status(400).json({ error: "Empty message" });

    // conversation ownership
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id,user_id,agent_slug")
      .eq("id", conversation_id)
      .maybeSingle();

    if (convErr || !conv) return res.status(404).json({ error: "Conversation not found" });
    if (conv.user_id !== userId) return res.status(403).json({ error: "Forbidden" });

    // agent
    const { data: agent, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id,slug,name")
      .eq("slug", agent_slug)
      .maybeSingle();

    if (agentErr || !agent) return res.status(404).json({ error: "Agent not found" });

    // licence/assignment: user must have this agent
    const { data: ua, error: uaErr } = await supabaseAdmin
      .from("user_agents")
      .select("id")
      .eq("user_id", userId)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (uaErr || !ua) return res.status(403).json({ error: "Agent not assigned to user" });

    // prompts
    const globalPrompt = await fetchUserGlobalPrompt({ userId });
    const { systemPrompt: agentPrompt } = await fetchAgentSystemPrompt({
      userId,
      agentId: agent.id,
      agentSlug: agent.slug,
    });

    const systemSections = [];
    if (globalPrompt) systemSections.push(globalPrompt);
    if (agentPrompt) systemSections.push(agentPrompt);

    const finalSystemPrompt = systemSections.join("\n\n---\n\n").trim();

    // history
    const history = await fetchConversationMessages(conversation_id, 30);

    // ensure last user message is present (frontend inserts it, but on évite les trous)
    const last = history[history.length - 1];
    if (!last || last.role !== "user" || last.content.trim() !== userMessage) {
      history.push({ role: "user", content: userMessage });
    }

    const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
    const model = process.env.MISTRAL_MODEL || "mistral-large-latest";

    const completion = await mistral.chat.complete({
      model,
      messages: [
        ...(finalSystemPrompt ? [{ role: "system", content: finalSystemPrompt }] : []),
        ...history,
      ],
      temperature: 0.2,
    });

    const reply =
      completion?.choices?.[0]?.message?.content ||
      completion?.output_text ||
      "";

    return res.status(200).json({ reply });
  } catch (e) {
    console.error("API /chat error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
}
