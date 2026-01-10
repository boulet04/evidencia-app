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

    const client_id = (req.query?.client_id || "").toString().trim();
    const user_id = (req.query?.user_id || "").toString().trim();
    const agent_slug = (req.query?.agent_slug || "").toString().trim();

    if (!client_id) return res.status(400).json({ error: "Missing client_id" });

    // 1) Récupérer les user_ids du client (ou un seul user si filtré)
    let userIds = [];
    if (user_id) {
      userIds = [user_id];
    } else {
      const { data: cu, error: cuErr } = await supabaseAdmin
        .from("client_users")
        .select("user_id")
        .eq("client_id", client_id);

      if (cuErr) return res.status(500).json({ error: cuErr.message });
      userIds = (cu || []).map((r) => r.user_id).filter(Boolean);
    }

    if (userIds.length === 0) return res.status(200).json({ conversations: [] });

    // 2) Charger les conversations
    let q = supabaseAdmin
      .from("conversations")
      .select("id,title,created_at,agent_slug,user_id")
      .in("user_id", userIds)
      .order("created_at", { ascending: false })
      .limit(500);

    if (agent_slug) q = q.eq("agent_slug", agent_slug);

    const { data: convs, error: convErr } = await q;
    if (convErr) return res.status(500).json({ error: convErr.message });

    const list = convs || [];
    if (list.length === 0) return res.status(200).json({ conversations: [] });

    // 3) Ajouter l’email
    const uniqUserIds = [...new Set(list.map((c) => c.user_id))];
    const { data: profs, error: profErr2 } = await supabaseAdmin
      .from("profiles")
      .select("user_id,email")
      .in("user_id", uniqUserIds);

    if (profErr2) return res.status(500).json({ error: profErr2.message });

    const emailByUserId = new Map((profs || []).map((p) => [p.user_id, p.email]));

    const enriched = list.map((c) => ({
      ...c,
      user_email: emailByUserId.get(c.user_id) || c.user_id,
    }));

    return res.status(200).json({ conversations: enriched });
  } catch (e) {
    console.error("Admin conversations list error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
