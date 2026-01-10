// /pages/api/chat.js

import { Mistral } from "@mistralai/mistralai";
import { createClient } from "@supabase/supabase-js";
import agentPrompts from "../../lib/agentPrompts";

const {
  MISTRAL_API_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  NEXT_PUBLIC_SUPABASE_URL,
  MAKE_WEBHOOK_URL,
  MISTRAL_MODEL,
} = process.env;

if (!NEXT_PUBLIC_SUPABASE_URL) {
  throw new Error("Missing env NEXT_PUBLIC_SUPABASE_URL");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing env SUPABASE_SERVICE_ROLE_KEY");
}
if (!MISTRAL_API_KEY) {
  throw new Error("Missing env MISTRAL_API_KEY");
}

const supabaseAdmin = createClient(
  NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function stripCodeFences(text) {
  const t = (text || "").trim();
  // ```json ... ```
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  return t;
}

function tryParseEmailJson(text) {
  const raw = stripCodeFences(text);
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  try {
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj === "object" &&
      typeof obj.to === "string" &&
      typeof obj.subject === "string" &&
      typeof obj.body === "string"
    ) {
      return { to: obj.to.trim(), subject: obj.subject, body: obj.body };
    }
    return null;
  } catch {
    return null;
  }
}

async function sendEmailViaMake({ to, subject, body }) {
  if (!MAKE_WEBHOOK_URL) {
    throw new Error("MAKE_WEBHOOK_URL is not configured on server");
  }

  const resp = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Webhook Make: attend {to, subject, body}
    body: JSON.stringify({ to, subject, body }),
  });

  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw new Error(`Make webhook error (${resp.status}): ${text || "no body"}`);
  }
  return { ok: true, status: resp.status, body: text };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Missing Bearer token" });

    const {
      conversationId,
      agentSlug,
      message,
      title,
    } = req.body || {};

    if (!agentSlug || typeof agentSlug !== "string") {
      return res.status(400).json({ error: "Missing agentSlug" });
    }
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing message" });
    }

    // Auth user
    const { data: authData, error: authErr } =
      await supabaseAdmin.auth.getUser(token);

    if (authErr || !authData?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const user = authData.user;

    // Check license expiration (profiles.expires_at)
    const { data: profile, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("expires_at, role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profErr) {
      return res.status(500).json({ error: "Failed to load profile" });
    }

    if (profile?.expires_at) {
      const exp = new Date(profile.expires_at).getTime();
      if (!Number.isNaN(exp) && Date.now() > exp && profile?.role !== "admin") {
        return res.status(403).json({
          error:
            "Abonnement expiré. Veuillez contacter Evidenc'IA pour renouveler votre abonnement.",
        });
      }
    }

    // Ensure conversation exists (or create)
    let convId = conversationId;
    if (!convId) {
      const { data: created, error: convErr } = await supabaseAdmin
        .from("conversations")
        .insert({
          user_id: user.id,
          agent_slug: agentSlug,
          title: title || null,
          archived: false,
        })
        .select("id")
        .single();

      if (convErr) {
        return res.status(500).json({ error: "Failed to create conversation" });
      }
      convId = created.id;
    }

    // Store user message
    const { error: insUserErr } = await supabaseAdmin.from("messages").insert({
      conversation_id: convId,
      role: "user",
      content: message,
    });

    if (insUserErr) {
      return res.status(500).json({ error: "Failed to save user message" });
    }

    // Load recent messages for context
    const { data: history, error: histErr } = await supabaseAdmin
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true })
      .limit(50);

    if (histErr) {
      return res.status(500).json({ error: "Failed to load message history" });
    }

    // Load agent config (client_agent_configs) if any (by agent_id via agents.slug)
    const { data: agentRow, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", agentSlug)
      .maybeSingle();

    if (agentErr || !agentRow?.id) {
      return res.status(400).json({ error: "Unknown agent slug" });
    }

    // Ensure user has access (user_agents)
    const { data: ua, error: uaErr } = await supabaseAdmin
      .from("user_agents")
      .select("id")
      .eq("user_id", user.id)
      .eq("agent_id", agentRow.id)
      .maybeSingle();

    if (uaErr) {
      return res.status(500).json({ error: "Failed to check user agent access" });
    }
    if (!ua && profile?.role !== "admin") {
      return res.status(403).json({ error: "Agent not assigned to this user" });
    }

    // Custom system prompt (client_agent_configs)
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", user.id)
      .eq("agent_id", agentRow.id)
      .maybeSingle();

    if (cfgErr) {
      return res.status(500).json({ error: "Failed to load agent config" });
    }

    const basePrompt =
      (cfg?.system_prompt && String(cfg.system_prompt).trim()) ||
      agentPrompts?.[agentSlug] ||
      `Tu es l'agent ${agentRow.name || agentSlug}.`;

    const contextJson = cfg?.context ? JSON.stringify(cfg.context) : "";

    const systemPrompt = contextJson
      ? `${basePrompt}\n\nCONTEXTE (json):\n${contextJson}`
      : basePrompt;

    // Build messages for Mistral
    const mistralMessages = [
      { role: "system", content: systemPrompt },
      ...(history || []).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    ];

    const model = MISTRAL_MODEL || "mistral-large-latest";

    const completion = await mistral.chat.complete({
      model,
      messages: mistralMessages,
      temperature: 0.2,
    });

    const assistantRaw =
      completion?.choices?.[0]?.message?.content?.toString?.() ??
      completion?.choices?.[0]?.message?.content ??
      "";

    // 1) Detect JSON email command
    const emailCmd = tryParseEmailJson(assistantRaw);

    let finalAssistantText = assistantRaw;
    let emailSent = false;
    let emailError = null;

    if (emailCmd) {
      try {
        await sendEmailViaMake(emailCmd);
        emailSent = true;

        // On remplace la réponse brute (JSON) par un message UI clair
        finalAssistantText =
          `L’email a été envoyé à ${emailCmd.to} avec l’objet "${emailCmd.subject}".`;
      } catch (e) {
        emailError = e?.message || String(e);
        finalAssistantText =
          `Erreur lors de l’envoi de l’email via Make : ${emailError}`;
      }
    }

    // Store assistant message
    const { error: insAsstErr } = await supabaseAdmin.from("messages").insert({
      conversation_id: convId,
      role: "assistant",
      content: finalAssistantText,
    });

    if (insAsstErr) {
      return res.status(500).json({ error: "Failed to save assistant message" });
    }

    return res.status(200).json({
      conversationId: convId,
      assistant: finalAssistantText,
      emailSent,
      emailError,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}
