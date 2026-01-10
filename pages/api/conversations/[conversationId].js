// pages/api/conversations/[conversationId].js
import { supabaseAdmin } from "../../../lib/supabaseAdmin";

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  try {
    const conversationId = (req.query?.conversationId || "").toString();
    if (!conversationId) return res.status(400).json({ error: "Missing conversationId" });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const { data: authData, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !authData?.user) return res.status(401).json({ error: "Invalid session" });

    const user = authData.user;

    if (req.method === "PATCH") {
      const title = (req.body?.title || "").toString().trim();
      if (!title) return res.status(400).json({ error: "Missing title" });

      const { data: updated, error: updErr } = await supabaseAdmin
        .from("conversations")
        .update({ title })
        .eq("id", conversationId)
        .eq("user_id", user.id)
        .select("id,title,created_at,agent_slug")
        .single();

      if (updErr) return res.status(500).json({ error: updErr.message });
      if (!updated) return res.status(404).json({ error: "Conversation not found" });

      return res.status(200).json({ conversation: updated });
    }

    if (req.method === "DELETE") {
      // Sécurisation: vérifier que la conversation appartient bien au user
      const { data: conv, error: convErr } = await supabaseAdmin
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (convErr) return res.status(500).json({ error: convErr.message });
      if (!conv) return res.status(404).json({ error: "Conversation not found" });

      // Supprimer messages puis conversation
      const { error: delMsgsErr } = await supabaseAdmin
        .from("messages")
        .delete()
        .eq("conversation_id", conversationId);

      if (delMsgsErr) return res.status(500).json({ error: delMsgsErr.message });

      const { error: delConvErr } = await supabaseAdmin
        .from("conversations")
        .delete()
        .eq("id", conversationId)
        .eq("user_id", user.id);

      if (delConvErr) return res.status(500).json({ error: delConvErr.message });

      return res.status(204).end();
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("API /conversations/[id] error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
