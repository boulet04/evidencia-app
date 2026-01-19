// pages/api/admin/toggle-user-agent.js
import { createClient } from "@supabase/supabase-js";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL manquant.");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquant.");

  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function setCors(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function safeStr(v) {
  return (v ?? "").toString().trim();
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(safeStr(v));
}

function isDuplicateError(error) {
  const msg = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();
  return code === "23505" || msg.includes("duplicate") || msg.includes("unique constraint");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    const supabaseAdmin = getSupabaseAdmin();

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide." });

    const adminId = userData.user.id;

    // Admin check: profiles.role === 'admin'
    const { data: profile, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", adminId)
      .maybeSingle();

    if (profErr) return res.status(500).json({ error: profErr.message });
    if (!profile || profile.role !== "admin") {
      return res.status(403).json({ error: "Accès interdit (admin requis)." });
    }

    const { userId, agentId, assign } = req.body || {};
    const uid = safeStr(userId);
    const aid = safeStr(agentId);
    const doAssign = !!assign;

    if (!uid) return res.status(400).json({ error: "userId manquant." });
    if (!aid) return res.status(400).json({ error: "agentId manquant." });

    // Validation UUID (évite inserts foireux)
    if (!isUuid(uid)) return res.status(400).json({ error: "userId invalide (UUID attendu)." });
    if (!isUuid(aid)) return res.status(400).json({ error: "agentId invalide (UUID attendu)." });

    if (doAssign) {
      const { error } = await supabaseAdmin.from("user_agents").insert([{ user_id: uid, agent_id: aid }]);

      // Si déjà existant, on considère OK
      if (error && !isDuplicateError(error)) {
        return res.status(500).json({ error: error.message || "Erreur insert user_agents." });
      }

      return res.status(200).json({ ok: true, assigned: true });
    }

    // Unassign
    const { error } = await supabaseAdmin.from("user_agents").delete().eq("user_id", uid).eq("agent_id", aid);
    if (error) return res.status(500).json({ error: error.message || "Erreur delete user_agents." });

    return res.status(200).json({ ok: true, assigned: false });
  } catch (e) {
    return res.status(500).json({ error: safeStr(e?.message) || "Erreur interne." });
  }
}
