// pages/api/conversations/delete.js
import { supabaseAdmin } from "../../../lib/supabaseAdmin";

function safeStr(v) {
  return (v ?? "").toString();
}

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide." });

    const userId = userData.user.id;

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const conversationId = safeStr(body.conversationId || body.conversation_id).trim();
    if (!conversationId) return res.status(400).json({ error: "conversationId manquant." });

    // admin ?
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();

    if (profileErr) return res.status(500).json({ error: "Erreur lecture profil." });
    const isAdmin = profile?.role === "admin";

    // ownership
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, user_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (convErr) return res.status(500).json({ error: "Erreur lecture conversation." });
    if (!conv) return res.status(404).json({ error: "Conversation introuvable." });

    if (!isAdmin && conv.user_id !== userId) return res.status(403).json({ error: "Accès interdit." });

    // delete messages then conversation
    const { error: delMsgErr } = await supabaseAdmin.from("messages").delete().eq("conversation_id", conversationId);
    if (delMsgErr) return res.status(500).json({ error: "Erreur suppression messages." });

    const { error: delConvErr } = await supabaseAdmin.from("conversations").delete().eq("id", conversationId);
    if (delConvErr) return res.status(500).json({ error: "Erreur suppression conversation." });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: safeStr(e?.message || e) });
  }
}
