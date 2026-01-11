// pages/api/chat.js
import { createClient } from "@supabase/supabase-js";
import { Mistral } from "@mistralai/mistralai";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const SUPABASE_URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const MISTRAL_API_KEY = requireEnv("MISTRAL_API_KEY");

// Optionnel : vous pouvez définir MISTRAL_MODEL dans Vercel (sinon fallback)
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-large-latest";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function nowIso() {
  return new Date().toISOString();
}

function isExpired(expiresAt) {
  if (!expiresAt) return false; // null = pas d'expiration
  const exp = new Date(expiresAt).getTime();
  return Number.isFinite(exp) && exp < Date.now();
}

function titleFromMessage(message) {
  if (!message) return "Nouvelle conversation";
  const s = String(message).trim().replace(/\s+/g, " ");
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }
    const user = authData.user;

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const agentSlug = body?.agentSlug || body?.agent_slug;
    const message = body?.message || body?.content;
    let conversationId = body?.conversationId || body?.conversation_id || null;

    if (!agentSlug) return res.status(400).json({ error: "Missing agentSlug" });
    if (!message) return res.status(400).json({ error: "Missing message" });

    // Profil (admin + expiration licence)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("role, expires_at")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profileError) {
      return res.status(500).json({ error: "Failed to load profile", details: profileError.message });
    }

    const isAdmin = profile?.role === "admin";
    if (!isAdmin && isExpired(profile?.expires_at)) {
      return res.status(403).json({
        error: "Subscription expired",
        message: "Votre abonnement a expiré. Veuillez contacter Evidenc'IA pour renouveler votre abonnement.",
      });
    }

    // Agent
    const { data: agent, error: agentError } = await supabaseAdmin
      .from("agents")
      .select("id, slug, name, description")
      .eq("slug", agentSlug)
      .maybeSingle();

    if (agentError) {
      return res.status(500).json({ error: "Failed to load agent", details: agentError.message });
    }
    if (!agent) {
      return res.status(404).json({ error: `Unknown agentSlug: ${agentSlug}` });
    }

    // Accès agent : admin bypass, sinon user_agents doit contenir (user_id, agent_id)
    if (!isAdmin) {
      const { data: ua, error: uaError } = await supabaseAdmin
        .from("user_agents")
        .select("id")
        .eq("user_id", user.id)
        .eq("agent_id", agent.id)
        .maybeSingle();

      if (uaError) {
        return res.status(500).json({ error: "Failed to check agent access", details: uaError.message });
      }
      if (!ua) {
        return res.status(403).json({ error: "Agent not assigned to user" });
      }
    }

    // Si conversationId fourni : vérifier ownership (sauf admin)
    if (conversationId) {
      const { data: conv, error: convError } = await supabaseAdmin
        .from("conversations")
        .select("id, user_id, agent_slug, archived")
        .eq("id", conversationId)
        .maybeSingle();

      if (convError) {
        return res.status(500).json({ error: "Failed to load conversation", details: convError.message });
      }
      if (!conv) {
        // Si l'ID n'existe pas : on le traite comme absent et on recrée proprement
        conversationId = null;
      } else if (!isAdmin && conv.user_id !== user.id) {
        return res.status(403).json({ error: "Conversation does not belong to user" });
      } else if (conv.agent_slug !== agentSlug) {
        // Optionnel : si conversationId pointe vers un autre agent, on refuse pour éviter mélange
        return res.status(400).json({ error: "conversationId does not match agentSlug" });
      }
    }

    // Charger éventuelle config personnalisée
    const { data: cfg, error: cfgError } = await supabaseAdmin
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", user.id)
      .eq("agent_id", agent.id)
      .maybeSingle();

    if (cfgError) {
      return res.status(500).json({ error: "Failed to load client_agent_configs", details: cfgError.message });
    }

    const systemPrompt =
      (cfg?.system_prompt && String(cfg.system_prompt).trim()) ||
      `Tu es ${agent.name || "un agent IA"} d’Evidenc'IA. Réponds en français, de manière claire et professionnelle.`;

    const context = cfg?.context || null;
    const systemContent =
      context ? `${systemPrompt}\n\nContexte (JSON):\n${JSON.stringify(context)}` : systemPrompt;

    // Créer conversation si absente (CORRECTIF PRINCIPAL)
    if (!conversationId) {
      const { data: newConv, error: newConvError } = await supabaseAdmin
        .from("conversations")
        .insert({
          user_id: user.id,
          agent_slug: agentSlug,
          title: titleFromMessage(message),
          archived: false,
        })
        .select("id")
        .single();

      if (newConvError) {
        return res.status(500).json({ error: "Failed to create conversation", details: newConvError.message });
      }

      conversationId = newConv.id;
    }

    // Charger historique messages (limité) pour contexte
    const { data: pastMessages, error: pastError } = await supabaseAdmin
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(30);

    if (pastError) {
      return res.status(500).json({ error: "Failed to load messages", details: pastError.message });
    }

    // Enregistrer le message user
    const { error: insertUserMsgError } = await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: String(message),
      created_at: nowIso(),
    });

    if (insertUserMsgError) {
      return res.status(500).json({ error: "Failed to save user message", details: insertUserMsgError.message });
    }

    const mistral = new Mistral({ apiKey: MISTRAL_API_KEY });

    // Construire messages pour Mistral
    const llmMessages = [
      { role: "system", content: systemContent },
      ...(pastMessages || []).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user", content: String(message) },
    ];

    const completion = await mistral.chat.complete({
      model: MISTRAL_MODEL,
      messages: llmMessages,
    });

    const assistantContent =
      completion?.choices?.[0]?.message?.content ??
      completion?.choices?.[0]?.message?.content?.[0]?.text ??
      "";

    if (!assistantContent) {
      return res.status(500).json({ error: "Empty assistant response" });
    }

    // Enregistrer message assistant
    const { error: insertAssistMsgError } = await supabaseAdmin.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: String(assistantContent),
      created_at: nowIso(),
    });

    if (insertAssistMsgError) {
      return res.status(500).json({ error: "Failed to save assistant message", details: insertAssistMsgError.message });
    }

    return res.status(200).json({
      ok: true,
      conversationId, // IMPORTANT : à stocker côté front
      reply: assistantContent,
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: e?.message || String(e) });
  }
}
