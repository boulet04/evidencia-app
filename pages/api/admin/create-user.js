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

async function assertAdmin(req) {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: "Token manquant." };

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return { ok: false, status: 401, error: "Session invalide." };

  const meId = userData.user.id;

  const { data: p, error: pErr } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("user_id", meId)
    .maybeSingle();

  if (pErr) return { ok: false, status: 500, error: "Erreur lecture profile admin." };
  if (p?.role !== "admin") return { ok: false, status: 403, error: "Accès refusé (non admin)." };

  return { ok: true, meId };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant." });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant." });
    }

    const auth = await assertAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const { clientId, email, password, role } = req.body || {};
    const cId = (clientId || "").toString().trim();
    const em = (email || "").toString().trim().toLowerCase();
    const pw = (password || "").toString();
    const rl = (role || "user").toString().trim() || "user";

    if (!cId) return res.status(400).json({ error: "clientId manquant." });
    if (!em || !isValidEmail(em)) return res.status(400).json({ error: "Email invalide." });
    if (!pw || pw.length < 6) return res.status(400).json({ error: "Mot de passe (min 6 caractères) requis." });
    if (!["user", "admin"].includes(rl)) return res.status(400).json({ error: "Role invalide (user/admin)." });

    // 1) Créer l’utilisateur dans Supabase Auth
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: em,
      password: pw,
      email_confirm: true,
    });

    if (createErr || !created?.user) {
      return res.status(500).json({ error: createErr?.message || "Création Auth user impossible." });
    }

    const newUserId = created.user.id;

    // 2) Upsert profile
    const { error: profErr } = await supabaseAdmin
      .from("profiles")
      .upsert(
        { user_id: newUserId, email: em, role: rl },
        { onConflict: "user_id" }
      );

    if (profErr) {
      return res.status(500).json({ error: "Profile insert/upsert impossible: " + profErr.message });
    }

    // 3) Lier user au client
    const { error: linkErr } = await supabaseAdmin
      .from("client_users")
      .insert({ client_id: cId, user_id: newUserId });

    if (linkErr) {
      return res.status(500).json({ error: "client_users insert impossible: " + linkErr.message });
    }

    return res.status(200).json({
      user: { user_id: newUserId, email: em, role: rl },
      client_user: { client_id: cId, user_id: newUserId },
    });
  } catch (e) {
    console.error("create-user error:", e);
    return res.status(500).json({ error: e?.message || "Erreur serveur create-user." });
  }
}
