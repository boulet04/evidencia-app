// pages/api/chat.js
import { Mistral } from "@mistralai/mistralai";
import { createClient } from "@supabase/supabase-js";

/**
 * Evidencia-app - API Chat
 * - Auth via Bearer token (supabaseAdmin.auth.getUser)
 * - Vérifie agent + assignation user_agents
 * - Charge prompt personnalisé via client_agent_configs (system_prompt / context)
 * - Fallback sur lib/agentPrompts (si présent)
 * - Appel Mistral chat.complete
 * - Si la réponse de l'IA est un JSON strict {to, subject, body}, déclenche Make (webhook) pour envoyer l'email.
 */

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const mistralApiKey = process.env.MISTRAL_API_KEY;
const makeWebhookUrl = process.env.MAKE_WEBHOOK_URL;

if (!supabaseUrl || !serviceRoleKey) {
  // Ne pas throw au top-level sur Vercel (cold start) : on gère en runtime.
}
if (!mistralApiKey) {
  // idem
}

const supabaseAdmin = createClient(supabaseUrl || "", serviceRoleKey || "", {
  auth: { persistSession: false },
});

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  const [type, token] = auth.split(" ");
  if (type !== "Bearer" || !token) return null;
  return token;
}

function safeJsonParse(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch {
    return { ok: false, value: null };
  }
}

function isStrictEmailJson(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== 3) return false;
  if (!("to" in obj) || !("subject" in obj) || !("body" in obj)) return false;
  if (typeof obj.to !== "string" || typeof obj.subject !== "string" || typeof obj.body !== "string") return false;
  if (!obj.to.trim() || !obj.subject.trim() || !obj.body.trim()) return false;
  return true;
}

async function sendToMakeEmail({ to, subject, body }) {
  if (!makeWebhookUrl) {
    return { ok: false, error: "MAKE_WEBHOOK_URL is not set" };
  }

  // Webhook Make en GET (query params) : simple et robuste
  const url =
    `${makeWebhookUrl}` +
    `?to=${encodeURIComponent(to)}` +
    `&subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;

  const resp = await fetch(url, { method: "GET" });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    return { ok: false, error: `Make webhook failed (${resp.status})`, details: text };
  }
  return { ok: true, details: text };
}

async function loadAgentFallbackPrompt(agentSlug) {
  // Fallback facultatif : lib/agentPrompts.js (ou .ts) si vous l’avez
  // Doit exporter un objet { [slug]: { systemPrompt, context } } ou similaire
  try {
    // eslint-disable-next-line import/no-unresolved
    const mod = await import("../../lib/agentPrompts");
    const prompts = mod?.default || mod?.agentPrompts || mod || null;
    if (!prompts) return null;

    const entry = prompts[agentSlug];
    if (!entry) return null;

    // Support de plusieurs formats
    const systemPrompt =
      entry.systemPrompt || entry.system_prompt || entry.prompt || entry.system || null;
    const context = entry.context || null;

    if (!systemPrompt) return null;
    return { systemPrompt, context };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: "Supabase env vars missing" });
    }
    if (!mistralApiKey) {
      return res.status(500).json({ error: "MISTRAL_API_KEY is missing" });
    }

    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const user = userData.user;

    // Body attendu
    // {
    //   agent_slug: string,
    //   messages: [{role:"user"|"assistant"|"system", content:string}, ...],
    //   conversation_id?: string
    // }
    const body = req.body || {};
    const agentSlug = body.agent_slug || body.agentSlug;
    const messages = Array.isArray(body.messages) ? body.messages : [];

    if (!agentSlug) {
      return res.status(400).json({ error: "agent_slug is required" });
    }
    if (!messages.length) {
      return res.status(400).json({ error: "messages[] is required" });
    }

    // 1) Vérifier l’agent existe
    const { data: agentRow, error: agentErr } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", agentSlug)
      .maybeSingle();

    if (agentErr) {
      return res.status(500).json({ error: "Failed to read agents", details: agentErr.message });
    }
    if (!agentRow) {
      return res.status(404).json({ error: `Unknown agent_slug: ${agentSlug}` });
    }

    // 2) Vérifier assignation user_agents (ou admin)
    const { data: profileRow } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    const isAdmin = profileRow?.role === "admin";

    if (!isAdmin) {
      const { data: uaRow, error: uaErr } = await supabaseAdmin
        .from("user_agents")
        .select("id")
        .eq("user_id", user.id)
        .eq("agent_id", agentRow.id)
        .maybeSingle();

      if (uaErr) {
        return res.status(500).json({ error: "Failed to read user_agents", details: uaErr.message });
      }
      if (!uaRow) {
        return res.status(403).json({ error: "Agent not assigned to this user" });
      }
    }

    // 3) Charger config personnalisée éventuelle
    let systemPrompt = null;
    let context = null;

    const { data: cfgRow, error: cfgErr } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", user.id)
      .eq("agent_id", agentRow.id)
      .maybeSingle();

    if (cfgErr) {
      return res.status(500).json({
        error: "Failed to read client_agent_configs",
        details: cfgErr.message,
      });
    }

    if (cfgRow?.system_prompt) {
      systemPrompt = cfgRow.system_prompt;
      context = cfgRow.context || null;
    } else {
      // fallback lib/agentPrompts
      const fallback = await loadAgentFallbackPrompt(agentSlug);
      if (fallback?.systemPrompt) {
        systemPrompt = fallback.systemPrompt;
        context = fallback.context || null;
      }
    }

    // 4) Construire le "system" final
    // On injecte context si présent (JSON -> texte)
    const systemParts = [];
    if (systemPrompt) systemParts.push(systemPrompt);

    if (context) {
      systemParts.push(
        `Contexte (JSON):\n${typeof context === "string" ? context : JSON.stringify(context, null, 2)}`
      );
    }

    const finalSystem = systemParts.length ? systemParts.join("\n\n") : null;

    // 5) Appel Mistral
    const mistral = new Mistral({ apiKey: mistralApiKey });

    const mistralMessages = [];
    if (finalSystem) {
      mistralMessages.push({ role: "system", content: finalSystem });
    }

    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      const role = m.role;
      const content = m.content;
      if (!role || typeof content !== "string") continue;
      if (!["system", "user", "assistant"].includes(role)) continue;
      mistralMessages.push({ role, content });
    }

    const completion = await mistral.chat.complete({
      model: "mistral-large-latest",
      messages: mistralMessages,
      temperature: 0.2,
    });

    const content =
      completion?.choices?.[0]?.message?.content ??
      completion?.choices?.[0]?.message?.content?.[0]?.text ??
      "";

    const assistantText = typeof content === "string" ? content : JSON.stringify(content);

    // 6) Si l'IA renvoie un JSON strict {to, subject, body} => on déclenche Make
    const parsed = safeJsonParse(assistantText.trim());
    if (parsed.ok && isStrictEmailJson(parsed.value)) {
      const email = parsed.value;

      const makeResult = await sendToMakeEmail(email);

      if (!makeResult.ok) {
        // On renvoie une erreur exploitable côté front (mais sans casser l'agent)
        return res.status(200).json({
          ok: true,
          agent_slug: agentSlug,
          emailRequested: true,
          emailSent: false,
          email,
          error: "EMAIL_SEND_FAILED",
          details: makeResult,
          content:
            "Je n'ai pas pu déclencher l'envoi de l'email via Make. Vérifiez MAKE_WEBHOOK_URL et le scénario Make.",
        });
      }

      return res.status(200).json({
        ok: true,
        agent_slug: agentSlug,
        emailRequested: true,
        emailSent: true,
        email,
        content: `Email envoyé à ${email.to}.`,
      });
    }

    // Sinon, réponse standard
    return res.status(200).json({
      ok: true,
      agent_slug: agentSlug,
      content: assistantText,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Internal server error",
      details: String(e?.message || e),
    });
  }
}
