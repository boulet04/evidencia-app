import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function setCors(res) {
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
  return (v ?? "").toString();
}

function isDuplicateError(err) {
  const msg = safeStr(err?.message).toLowerCase();
  return msg.includes("duplicate") || msg.includes("already exists") || msg.includes("unique");
}

async function requireAdmin(token) {
  const { data: u, error: uErr } = await supabaseAdmin.auth.getUser(token);
  if (uErr || !u?.user) return { ok: false, status: 401, error: "Session invalide." };

  const { data: p, error: pErr } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("user_id", u.user.id)
    .maybeSingle();

  if (pErr) return { ok: false, status: 500, error: pErr.message };

  const isAdmin = p?.role === "admin";
  if (!isAdmin) return { ok: false, status: 403, error: "Accès interdit." };

  return { ok: true, userId: u.user.id };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant sur Vercel." });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant sur Vercel." });
    }

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Non authentifié." });

    const adminCheck = await requireAdmin(token);
    if (!adminCheck.ok) return res.status(adminCheck.status).json({ error: adminCheck.error });

    const clientId = safeStr(req.body?.clientId).trim();
    const email = safeStr(req.body?.email).trim().toLowerCase();
    const password = safeStr(req.body?.password);
    const role = safeStr(req.body?.role || "user");

    if (!clientId) return res.status(400).json({ error: "clientId manquant." });
    if (!email) return res.status(400).json({ error: "Email obligatoire." });
    if (!password || password.length < 6) {
      return res.status(400).json({ error: "Mot de passe min 6 caractères." });
    }
    if (role !== "user" && role !== "admin") {
      return res.status(400).json({ error: "Rôle invalide." });
    }

    // 1) create auth user
    const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (cErr || !created?.user) {
      return res.status(500).json({ error: cErr?.message || "Création Auth impossible." });
    }

    const newUserId = created.user.id;

    // 2) create profile
    const { error: profErr } = await supabaseAdmin.from("profiles").insert({
      user_id: newUserId,
      email,
      role,
    });

    if (profErr && !isDuplicateError(profErr)) {
      return res.status(500).json({ error: profErr.message });
    }

    // 3) link to client
    const { error: linkErr } = await supabaseAdmin.from("client_users").insert({
      client_id: clientId,
      user_id: newUserId,
    });

    if (linkErr && !isDuplicateError(linkErr)) {
      return res.status(500).json({ error: linkErr.message });
    }

    return res.status(200).json({ user: { id: newUserId, email, role } });
  } catch (e) {
    console.error("create-user error:", e);
    return res.status(500).json({ error: safeStr(e?.message) || "Erreur interne." });
  }
}
