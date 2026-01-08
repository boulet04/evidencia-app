// pages/api/admin/create-user.js
import { createClient } from "@supabase/supabase-js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function randomPassword(len = 14) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function isDuplicateError(msg) {
  const s = String(msg || "").toLowerCase();
  return s.includes("duplicate") || s.includes("already exists") || s.includes("already been registered");
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

/**
 * Trouver un userId Auth existant par email.
 * Supabase Auth n’a pas “getUserByEmail” direct, donc on itère listUsers.
 * OK tant que tu n’as pas des milliers d’utilisateurs.
 */
async function findAuthUserIdByEmail(supabaseAdmin, emailLower) {
  const perPage = 200;

  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);

    const users = data?.users || [];
    const found = users.find((u) => (u?.email || "").toLowerCase() === emailLower);
    if (found?.id) return found.id;

    // si moins que perPage, on est à la fin
    if (users.length < perPage) break;
  }

  return "";
}

export default async function handler(req, res) {
  setCors(res);

  try {
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

    const supabaseAdmin = getSupabaseAdmin();
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    await requireAdmin(supabaseAdmin, token);

    const clientId = safeStr(req.body?.clientId);
    const email = safeStr(req.body?.email).toLowerCase();
    const role = safeStr(req.body?.role || "user") || "user";
    const passwordFromUI = safeStr(req.body?.password || ""); // optionnel

    if (!clientId) return res.status(400).json({ error: "clientId manquant." });
    if (!isUuid(clientId)) return res.status(400).json({ error: "clientId invalide (UUID attendu)." });

    if (!email) return res.status(400).json({ error: "Email manquant." });
    if (!isEmail(email)) return res.status(400).json({ error: "Email invalide." });

    // Mot de passe optionnel : si pas fourni -> random.
    // Si fourni, on accepte (min 8) sinon on refuse.
    let password = passwordFromUI;
    if (password && password.length < 8) {
      return res.status(400).json({ error: "Mot de passe trop court (8 caractères minimum)." });
    }
    if (!password) password = randomPassword(14);

    // 1) Tenter de créer l’utilisateur Auth
    let userId = "";
    let createdNewAuthUser = false;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createErr) {
      // Si déjà enregistré, on récupère le userId existant et on continue.
      if (isDuplicateError(createErr.message)) {
        userId = await findAuthUserIdByEmail(supabaseAdmin, email);

        if (!userId) {
          // fallback possible si profiles.email est rempli
          const { data: p, error: pErr } = await supabaseAdmin
            .from("profiles")
            .select("user_id")
            .eq("email", email)
            .maybeSingle();

          if (pErr) throw new Error(pErr.message);
          userId = p?.user_id || "";
        }

        if (!userId) {
          return res.status(409).json({
            error:
              "Utilisateur déjà existant, mais impossible de récupérer son userId. Vérifie que profiles.email est rempli, ou que Auth contient bien cet email.",
          });
        }
      } else {
        return res.status(500).json({ error: createErr.message });
      }
    } else {
      userId = created?.user?.id || "";
      createdNewAuthUser = true;
      if (!userId) return res.status(500).json({ error: "Création Auth OK mais userId absent." });
    }

    // 2) Upsert profile
    const { error: profErr } = await supabaseAdmin
      .from("profiles")
      .upsert([{ user_id: userId, email, role }], { onConflict: "user_id" });

    if (profErr) return res.status(500).json({ error: profErr.message });

    // 3) Lier au client (ignore duplication)
    const { error: linkErr } = await supabaseAdmin.from("client_users").insert([{ client_id: clientId, user_id: userId }]);
    if (linkErr && !isDuplicateError(linkErr.message)) {
      return res.status(500).json({ error: linkErr.message });
    }

    return res.status(200).json({
      ok: true,
      user: { id: userId, email, role },
      createdNewAuthUser,
      tempPassword: createdNewAuthUser ? password : null,
      note: createdNewAuthUser
        ? "Utilisateur créé et rattaché au client."
        : "Utilisateur déjà existant : rattaché au client.",
    });
  } catch (e) {
    const status = e?.status || 500;
    return res.status(status).json({ error: safeStr(e?.message) || "Erreur interne create-user." });
  }
}
