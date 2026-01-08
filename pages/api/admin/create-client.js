import { createClient } from "@supabase/supabase-js";

function safeStr(v) {
  return (v ?? "").toString().trim();
}

function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL) return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant." });
    if (!SERVICE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant." });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    // Client admin (service role) — côté serveur uniquement
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // 1) Vérifier session
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Session invalide." });
    }

    // 2) Vérifier role admin via profiles.role
    const adminId = userData.user.id;
    const { data: profile, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", adminId)
      .maybeSingle();

    if (profErr) return res.status(500).json({ error: profErr.message });
    if (!profile || profile.role !== "admin") {
      return res.status(403).json({ error: "Accès interdit (admin requis)." });
    }

    // 3) Créer client
    const name = safeStr(req.body?.name);
    if (!name) return res.status(400).json({ error: "Nom du client manquant." });

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("clients")
      .insert([{ name }])
      .select("id,name,created_at")
      .maybeSingle();

    if (insErr) {
      return res.status(500).json({
        error: "Insert clients échoué.",
        detail: insErr.message,
      });
    }

    return res.status(200).json({ ok: true, client: inserted });
  } catch (e) {
    return res.status(500).json({
      error: "Erreur interne create-client.",
      detail: safeStr(e?.message) || "Erreur inconnue.",
    });
  }
}
