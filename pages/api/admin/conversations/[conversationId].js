// pages/api/admin/conversations/[conversationId].js
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function requireAdmin(req) {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: "Missing Authorization Bearer token" };

  const { data: authData, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !authData?.user) return { ok: false, status: 401, error: "Invalid session" };

  const user = authData.user;

  const { data: prof, error: profErr } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profErr) return { ok: false, status: 500, error: profErr.message };
  if (!prof || prof.role !== "admin") return { ok: false, status: 403, error: "Forbidden" };

  return { ok: true, user };
}

export default async function handler(req, res) {
  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) return res.status(admin.status).json({ error: admin.error });

    const conversationId = (req.query?.conversationId || "").toString().trim();
    if (!conversationId) return res.status(400).json({ error: "Missing conversationId" });

    if (req.method !== "DELETE") return res.status(405).json({ error: "Method not allowed" });

    // Supprimer messages puis conversation
    const { error: delMsgsErr } = await supabaseAdmin
      .from("messages")
      .delete()
      .eq("conversation_id", conversationId);

    if (delMsgsErr) return res.status(500).json({ error: delMsgsErr.message });

    const { error: delConvErr } = await supabaseAdmin
      .from("conversations")
      .delete()
      .eq("id", conversationId);

    if (delConvErr) return res.status(500).json({ error: delConvErr.message });

    return res.status(204).end();
  } catch (e) {
    console.error("Admin delete conversation error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
