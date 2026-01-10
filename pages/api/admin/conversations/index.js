// pages/api/admin/conversations/index.js
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

  // Admin via profiles.role = 'admin'
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

    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const user_id = (req.query?.user_id || "").toString().trim();
    const agent_slug = (req.query?.agent_slug || "").toString().trim();

    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!agent_slug) return res.status(400).json({ error: "Missing agent_slug" });

    const { data, error } = await supabaseAdmin
      .from("conversations")
      .select("id,title,created_at,agent_slug,user_id")
      .eq("user_id", user_id)
      .eq("agent_slug", agent_slug)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ conversations: data || [] });
  } catch (e) {
    console.error("Admin conversations list error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
