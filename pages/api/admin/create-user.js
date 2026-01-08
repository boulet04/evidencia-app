// pages/api/admin/create-user.js
import { createClient } from "@supabase/supabase-js";

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
  return (v ?? "").toString().trim();
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
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
    const msg = userErr?.message || "Session invalide.";
    const e = new Error(msg);
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

function randomPassword(len = 14) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function isAlreadyRegisteredError(msg) {
  const m = (msg || "").toLowerCase();
  return m.includes("already been registered") || m.includes("already registered");
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
    const passwordIn = safeStr(req.body?.password); // optionnel

    if (!clientId) return res.status(400).json({ error: "clientId manquant." });
    if (!isUuid(clientId)) return res.status(400).json({ error: "clientId invalide (UUID attendu)." });

    if (!email) return res.status(400).json({ error: "Email manquant." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Email invalide." });

    // 1) Create Auth user (ou réutiliser si déjà existant)
    const password = passwordIn || randomPassword(14);

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    // Si déjà existant => on récupère user_id depuis profiles (source de vérité côté DB)
    if (createErr && isAlreadyRegisteredError(createErr.message)) {
      const { data: existingProfile, error: profLookupErr } = await supabaseAdmin
        .from("profiles")
        .select("user_id,email,role")
        .eq("email", email)
        .maybeSingle();

      if (profLookupErr) return res.status(500).json({ error: profLookupErr.message });

      if (!existingProfile?.user_id) {
        return res.status(409).json({
          error:
            "Email déjà enregistré dans Auth, mais introuvable dans profiles. Vérifie la table profiles (colonne email) ou supprime l’utilisateur côté Auth si nécessaire.",
        });
      }

      const userId = existingProfile.user_id;

      // Upsert profile (met à jour role si besoin)
      const { error: upErr } = await supabaseAdmin
        .from("profiles")
        .upsert([{ user_id: userId, email, role }], { onConflict: "user_id" });

      if (upErr) return res.status(500).json({ error: upErr.message });

      // Link au client (ignore si déjà lié)
      const { error: linkErr } = await supabaseAdmin.from("client_users").insert([{ client_id: clientId, user_id: userId }]);
      if (linkErr && !String(linkErr.message || "").toLowerCase().includes("duplicate")) {
        return res.status(500).json({ error: linkErr.message });
      }

      return res.status(200).json({
        ok: true,
        existing: true,
        user: { id: userId, email, role },
        tempPassword: null,
      });
    }

    if (createErr) return res.status(500).json({ error: createErr.message });

    const userId = created?.user?.id;
    if (!userId) return res.status(500).json({ error: "Création Auth OK mais userId absent." });

    // 2) profile
    const { error: profErr } = await supabaseAdmin
      .from("profiles")
      .upsert([{ user_id: userId, email, role }], { onConflict: "user_id" });

    if (profErr) return res.status(500).json({ error: profErr.message });

    // 3) link client_users
    const { error: linkErr } = await supabaseAdmin.from("client_users").insert([{ client_id: clientId, user_id: userId }]);
    if (linkErr) return res.status(500).json({ error: linkErr.message });

    return res.status(200).json({
      ok: true,
      existing: false,
      user: { id: userId, email, role },
      tempPassword: password, // si password fourni, on te le renvoie pareil (tu peux choisir de ne pas l’afficher)
    });
  } catch (e) {
    const status = e?.status || 500;
    return res.status(status).json({
      error: safeStr(e?.message) || "Erreur interne create-user.",
    });
  }
}
