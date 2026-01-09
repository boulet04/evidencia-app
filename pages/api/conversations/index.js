import { createClient } from "@supabase/supabase-js";

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function guessFirstNameFromEmail(email) {
  if (!email) return "";
  const local = email.split("@")[0] || "";
  // jb.bernier -> jb / bernier ; on prend le 1er segment "humain"
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return "";
  // si le premier segment est très court (ex: jb), tenter le second
  const cand = parts[0].length <= 2 && parts[1] ? parts[1] : parts[0];
  return capitalize(cand);
}

function extractFirstName(user) {
  const md = user?.user_metadata || {};
  const direct =
    md.first_name ||
    md.prenom ||
    md.firstname ||
    md.given_name ||
    md.name ||
    md.full_name ||
    md.fullName;

  if (typeof direct === "string" && direct.trim()) {
    const first = direct.trim().split(/\s+/)[0];
    return capitalize(first);
  }

  return guessFirstNameFromEmail(user?.email || "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "Missing Bearer token" });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      error: "Server misconfiguration: missing SUPABASE env vars",
    });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: "Invalid token" });
  }

  const user = userData.user;
  const userId = user.id;

  const { agent_slug } = req.body || {};
  if (!agent_slug || typeof agent_slug !== "string") {
    return res.status(400).json({ error: "Missing agent_slug" });
  }

  // Optionnel : charger le nom d’agent pour titre
  const { data: agent } = await supabaseAdmin
    .from("agents")
    .select("name")
    .eq("slug", agent_slug)
    .maybeSingle();

  const title = agent?.name ? `Discussion avec ${agent.name}` : "Nouvelle conversation";

  // 1) create conversation
  const { data: conv, error: convErr } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: userId,
      agent_slug,
      title,
      archived: false,
    })
    .select("id,title,created_at,agent_slug")
    .single();

  if (convErr) return res.status(500).json({ error: convErr.message });

  // 2) create welcome message
  const firstName = extractFirstName(user);
  const welcome = firstName
    ? `Bonjour ${firstName}, comment puis-je vous aider ?`
    : "Bonjour, comment puis-je vous aider ?";

  const { error: msgErr } = await supabaseAdmin.from("messages").insert({
    conversation_id: conv.id,
    role: "assistant",
    content: welcome,
  });

  // Si insertion message échoue, on retourne quand même la conversation
  if (msgErr) {
    return res.status(201).json({
      conversation: conv,
      warning: `Conversation created but welcome message failed: ${msgErr.message}`,
    });
  }

  return res.status(201).json({ conversation: conv });
}
