// pages/api/conversations/delete.js
import { createClient } from "@supabase/supabase-js";

function safeStr(v) {
  return (v ?? "").toString().trim();
}

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    safeStr(v)
  );
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant." });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant." });

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    // session user
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide." });

    const userId = userData.user.id;

    // body
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const conversationId = body.conversationId || body.conversation_id || body.id || "";
    if (!isUuid(conversationId)) return res.status(400).json({ error: "conversationId invalide." });

    // On récupère la conversation
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, user_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (convErr) return res.status(500).json({ error: convErr.message });
    if (!conv) return res.status(404).json({ error: "Conversation introuvable." });

    // Autorisation : propriétaire ou admin
    if (safeStr(conv.user_id) !== safeStr(userId)) {
      const { data: prof, error: profErr } = await supabaseAdmin
        .from("profiles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();

      if (profErr) return res.status(500).json({ error: profErr.message });
      if (safeStr(prof?.role) !== "admin") {
        return res.status(403).json({ error: "Accès interdit." });
      }
    }

    // Supprime messages puis conversation
    const { error: mErr } = await supabaseAdmin
      .from("messages")
      .delete()
      .eq("conversation_id", conversationId);
    if (mErr) return res.status(500).json({ error: mErr.message });

    const { error: cErr } = await supabaseAdmin
      .from("conversations")
      .delete()
      .eq("id", conversationId);
    if (cErr) return res.status(500).json({ error: cErr.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: safeStr(e?.message) || "Erreur interne." });
  }
}
