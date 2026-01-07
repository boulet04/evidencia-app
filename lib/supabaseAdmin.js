// lib/supabaseAdmin.js
import { createClient } from "@supabase/supabase-js";

let _admin = null;

export function supabaseAdmin() {
  if (_admin) return _admin;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL manquant.");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY manquant.");

  _admin = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  return _admin;
}

export function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

export function safeStr(v) {
  return (v ?? "").toString();
}

export async function requireAdmin(req) {
  const sb = supabaseAdmin();
  const token = getBearerToken(req);

  if (!token) {
    return { ok: false, status: 401, error: "Non authentifié (token manquant)." };
  }

  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData?.user) {
    return { ok: false, status: 401, error: "Session invalide. Reconnectez-vous." };
  }

  const userId = userData.user.id;

  // On lit le profil via service role (pas bloqué par RLS)
  const { data: prof, error: profErr } = await sb
    .from("profiles")
    .select("user_id, email, role, is_admin")
    .eq("user_id", userId)
    .maybeSingle();

  if (profErr) {
    return { ok: false, status: 500, error: `Erreur profiles: ${profErr.message}` };
  }

  const isAdmin = !!prof?.is_admin || prof?.role === "admin";
  if (!isAdmin) {
    return { ok: false, status: 403, error: "Accès refusé : admin requis." };
  }

  return { ok: true, userId, profile: prof, token };
}
