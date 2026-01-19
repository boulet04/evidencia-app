// pages/api/admin/save-base-prompt.js
import { createClient } from "@supabase/supabase-js";

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function safeStr(v) {
  return (v ?? "").toString();
}

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }

  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide." });

    const userId = userData.user.id;

    const { data: prof, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();

    if (profErr || safeStr(prof?.role) !== "admin") {
      return res.status(403).json({ error: "Accès admin requis." });
    }

    const value = safeStr(req.body?.value).trim();

    await supabaseAdmin.from("app_settings").upsert(
      {
        key: "base_system_prompt",
        value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Erreur interne.", detail: safeStr(err?.message || err) });
  }
}
