// pages/api/admin/toggle-user-agent.js
import { createClient } from "@supabase/supabase-js";

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
  const s = safeStr(v);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL manquant.");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquant.");

  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

async function requireAdmin({ supabaseAdmin, token }) {
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return { ok: false, status: 401, error: "Session invalide. Reconnectez-vous." };
  }

  const adminId = userData.user.id;

  const { data: profile, error: profErr } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("user_id", adminId)
    .maybeSingle();

  if (profErr) {
    return { ok: false, status: 500, error: profErr.message || "Erreur profiles." };
  }

  // Règle demandée: admin via profiles.role === 'admin' (pas via is_admin)
  if (!profile || profile.role !== "admin") {
    return { ok: false, status: 403, error: "Accès interdit (admin requis)." };
  }

  return { ok: true, adminId };
}

export default async function handler(req, res) {
  try {
    setCors(res);

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    const supabaseAdmin = getSupabaseAdmin();

    const adminCheck = await requireAdmin({ supabaseAdmin, token });
    if (!adminCheck.ok) return res.status(adminCheck.status).json({ error: adminCheck.error });

    const { userId, agentId, assign } = req.body || {};
    const uid = safeStr(userId);
    const aid = safeStr(agentId);
    const doAssign = !!assign;

    if (!uid) return res.status(400).json({ error: "userId manquant." });
    if (!aid) return res.status(400).json({ error: "agentId manquant." });

    // Validation simple pour éviter des insert foireux / injections de string
    if (!isUuid(uid)) return res
