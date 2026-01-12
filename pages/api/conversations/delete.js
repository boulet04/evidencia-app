// pages/api/conversations/delete.js
import * as supabaseModule from "../../../lib/supabaseAdmin";

function getSupabaseAdmin() {
  // Compatible export default OU export nommé
  return supabaseModule.supabaseAdmin || supabaseModule.default;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // Preflight éventuel
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) {
      return res.status(500).json({
        ok: false,
        error: "supabaseAdmin is undefined (check lib/supabaseAdmin export).",
      });
    }

    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (!token) {
      return res.status(401).json({ ok: false, error: "Missing bearer token" });
    }

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    const user = userData?.user;

    if (userErr || !user) {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }

    // Body peut être déjà parsé (objet) ou string
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const conversationId = body.conversationId;

    if (!conversationId) {
      return res.status(400).json({ ok: false, error: "Missing conversationId" });
    }

    // Vérifie ownership
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, user_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (convErr) return res.status(500).json({ ok: false, error: convErr.message });
    if (!conv) return res.status(404).json({ ok: false, error: "Conversation not found" });
    if (conv.user_id !== user.id) return res.status(403).json({ ok: false, error: "Forbidden" });

    // Supprime messages puis conversation
    const { error: msgErr } = await supabaseAdmin
      .from("messages")
      .delete()
      .eq("conversation_id", conversationId);

    if (msgErr) return res.status(500).json({ ok: false, error: msgErr.message });

    const { error: delErr } = await supabaseAdmin
      .from("conversations")
      .delete()
      .eq("id", conversationId);

    if (delErr) return res.status(500).json({ ok: false, error: delErr.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: (e?.message || "Server error").toString(),
    });
  }
}
