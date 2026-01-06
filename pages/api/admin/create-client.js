// pages/api/admin/create-client.js
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
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide." });

    const adminId = userData.user.id;

    const { data: adminProfile, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", adminId)
      .maybeSingle();

    if (profErr || adminProfile?.role !== "admin") {
      return res.status(403).json({ error: "Accès interdit (admin requis)." });
    }

    const { name } = req.body || {};
    const clientName = safeStr(name);

    if (!clientName) return res.status(400).json({ error: "Nom client manquant." });

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("clients")
      .insert({ name: clientName })
      .select("id, name, created_at")
      .single();

    if (insErr) {
      // unique violation -> client existe déjà
      if ((insErr.code || "").toString() === "23505") {
        return res.status(409).json({ error: "Ce client existe déjà." });
      }
      return res.status(500).json({ error: "Création client échouée.", details: insErr.message });
    }

    return res.status(200).json({ ok: true, client: inserted });
  } catch (e) {
    console.error("create-client error:", e);
    return res.status(500).json({ error: "Erreur interne." });
  }
}
