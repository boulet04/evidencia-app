import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function safeStr(v) {
  return (v ?? "").toString().trim();
}

export default async function handler(req, res) {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide." });

    const adminId = userData.user.id;
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", adminId)
      .maybeSingle();

    if (!profile || profile.role !== "admin") {
      return res.status(403).json({ error: "Accès interdit (admin requis)." });
    }

    const { userId, agentSlug } = req.body || {};
    const uid = safeStr(userId);
    const slug = safeStr(agentSlug);
    if (!uid) return res.status(400).json({ error: "userId manquant." });
    if (!slug) return res.status(400).json({ error: "agentSlug manquant." });

    // 1) récupérer les conversations
    const { data: convs, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("user_id", uid)
      .eq("agent_slug", slug);

    if (convErr) return res.status(500).json({ error: convErr.message });

    const ids = (convs || []).map((c) => c.id);
    if (ids.length === 0) return res.status(200).json({ ok: true, deleted: 0 });

    // 2) supprimer messages
    const { error: msgErr } = await supabaseAdmin
      .from("messages")
      .delete()
      .in("conversation_id", ids);

    if (msgErr) return res.status(500).json({ error: msgErr.message });

    // 3) supprimer conversations
    const { error: delErr } = await supabaseAdmin
      .from("conversations")
      .delete()
      .in("id", ids);

    if (delErr) return res.status(500).json({ error: delErr.message });

    return res.status(200).json({ ok: true, deleted: ids.length });
  } catch (e) {
    return res.status(500).json({ error: safeStr(e?.message) || "Erreur interne." });
  }
}
