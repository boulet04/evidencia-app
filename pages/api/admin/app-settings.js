// pages/api/admin/app-settings.js
import { createClient } from "@supabase/supabase-js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL manquant.");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquant.");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

async function requireAdmin(supabaseAdmin, token) {
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) {
    const e = new Error(userErr?.message || "Session invalide.");
    e.status = 401;
    throw e;
  }

  const adminId = userData.user.id;

  const { data: profile, error: profErr } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("user_id", adminId)
    .maybeSingle();

  if (profErr) {
    const e = new Error(profErr.message);
    e.status = 500;
    throw e;
  }

  if (!profile || profile.role !== "admin") {
    const e = new Error("Accès interdit (admin requis).");
    e.status = 403;
    throw e;
  }

  return { adminId };
}

export default async function handler(req, res) {
  setCors(res);
  try {
    if (req.method === "OPTIONS") return res.status(200).end();

    const supabaseAdmin = getSupabaseAdmin();
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    await requireAdmin(supabaseAdmin, token);

    if (req.method === "GET") {
      const key = safeStr(req.query?.key);
      if (!key) return res.status(400).json({ error: "Paramètre key manquant." });

      const { data, error } = await supabaseAdmin
        .from("app_settings")
        .select("key,value,updated_at")
        .eq("key", key)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json({ ok: true, item: data || null });
    }

    if (req.method === "POST") {
      const key = safeStr(req.body?.key);
      const value = (req.body?.value ?? "").toString();

      if (!key) return res.status(400).json({ error: "key manquant." });

      const payload = { key, value, updated_at: new Date().toISOString() };

      const { data, error } = await supabaseAdmin
        .from("app_settings")
        .upsert(payload, { onConflict: "key" })
        .select("key,value,updated_at")
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });

      return res.status(200).json({ ok: true, item: data });
    }

    return res.status(405).json({ error: "Méthode non autorisée." });
  } catch (e) {
    const status = e?.status || 500;
    return res.status(status).json({ error: safeStr(e?.message) || "Erreur interne app-settings." });
  }
}
