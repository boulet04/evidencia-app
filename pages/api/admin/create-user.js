// pages/api/admin/create-user.js
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

    const { clientId, email, password, role } = req.body || {};
    const cid = safeStr(clientId);
    const em = safeStr(email).toLowerCase();
    const pw = safeStr(password);
    const r = safeStr(role) || "user";

    if (!cid) return res.status(400).json({ error: "clientId manquant." });
    if (!em) return res.status(400).json({ error: "Email manquant." });
    if (!pw || pw.length < 6) return res.status(400).json({ error: "Mot de passe (min 6) manquant." });
    if (!["user", "admin"].includes(r)) return res.status(400).json({ error: "Role invalide." });

    const { data: clientRow, error: cErr } = await supabaseAdmin
      .from("clients")
      .select("id, name")
      .eq("id", cid)
      .maybeSingle();

    if (cErr || !clientRow) return res.status(404).json({ error: "Client introuvable." });

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: em,
      password: pw,
      email_confirm: true,
    });

    if (createErr || !created?.user?.id) {
      return res.status(500).json({ error: "Création utilisateur échouée.", details: createErr?.message || "" });
    }

    const newUserId = created.user.id;

    const { error: upErr } = await supabaseAdmin.from("profiles").upsert({
      user_id: newUserId,
      role: r,
      client_id: clientRow.id,
      client_name: clientRow.name,
    });

    if (upErr) return res.status(500).json({ error: "Profile non créé.", details: upErr.message });

    return res.status(200).json({
      ok: true,
      client: clientRow,
      user: { id: newUserId, email: em, role: r },
      note: "Le mot de passe n’est pas récupérable après création (normal).",
    });
  } catch (e) {
    console.error("create-user error:", e);
    return res.status(500).json({ error: "Erreur interne." });
  }
}
