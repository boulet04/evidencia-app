// pages/api/admin/create-user.js test
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "../../../lib/sendEmail";

function setCors(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
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

function randomPassword(len = 14) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function looksLikeAlreadyRegistered(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("already been registered") ||
    msg.includes("already registered") ||
    msg.includes("user already") ||
    (msg.includes("email") && msg.includes("registered"))
  );
}

async function findAuthUserByEmail(supabaseAdmin, email) {
  const target = safeStr(email).toLowerCase();
  if (!target) return null;

  let page = 1;
  const perPage = 200;

  for (let i = 0; i < 20; i++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const users = data?.users || [];
    const found = users.find((u) => (u?.email || "").toLowerCase() === target);
    if (found) return found;

    if (users.length < perPage) break;
    page += 1;
  }

  return null;
}

function buildInviteEmail({ appUrl, email, password, isNew }) {
  const loginUrl = `${appUrl.replace(/\/$/, "")}/login`;

  const subject = isNew
    ? "Vos accès Evidenc'IA"
    : "Vous avez été rattaché à un client sur Evidenc'IA";

  const text = isNew
    ? `Bonjour,\n\nVotre compte Evidenc'IA est prêt.\n\nConnexion: ${loginUrl}\nIdentifiant: ${email}\nMot de passe: ${password}\n\nVous pouvez changer votre mot de passe après connexion.\n`
    : `Bonjour,\n\nVous avez été rattaché à un client sur Evidenc'IA.\n\nConnexion: ${loginUrl}\nIdentifiant: ${email}\n\nSi vous avez oublié votre mot de passe, utilisez “Mot de passe oublié”.\n`;

  const html = isNew
    ? `
      <div style="font-family: Arial, sans-serif; line-height:1.45;">
        <h2>Vos accès Evidenc'IA</h2>
        <p>Bonjour,</p>
        <p>Votre compte est prêt.</p>
        <p><b>Connexion</b> : <a href="${loginUrl}">${loginUrl}</a><br/>
           <b>Identifiant</b> : ${email}<br/>
           <b>Mot de passe</b> : <span style="font-family:monospace;">${password}</span>
        </p>
        <p>Vous pourrez modifier votre mot de passe après connexion.</p>
      </div>
    `
    : `
      <div style="font-family: Arial, sans-serif; line-height:1.45;">
        <h2>Evidenc'IA</h2>
        <p>Bonjour,</p>
        <p>Votre compte a été rattaché à un client.</p>
        <p><b>Connexion</b> : <a href="${loginUrl}">${loginUrl}</a><br/>
           <b>Identifiant</b> : ${email}
        </p>
        <p>Si vous avez oublié votre mot de passe, utilisez “Mot de passe oublié”.</p>
      </div>
    `;

  return { subject, text, html };
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
    const passwordFromUI = safeStr(req.body?.password || "") || null;

    if (!clientId) return res.status(400).json({ error: "clientId manquant." });
    if (!isUuid(clientId)) return res.status(400).json({ error: "clientId invalide (UUID attendu)." });

    if (!email) return res.status(400).json({ error: "Email manquant." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Email invalide." });

    // Vérifie que le client existe
    {
      const { data: c, error: cErr } = await supabaseAdmin.from("clients").select("id").eq("id", clientId).maybeSingle();
      if (cErr) return res.status(500).json({ error: cErr.message });
      if (!c) return res.status(400).json({ error: "Client introuvable (clientId invalide côté DB)." });
    }

    // Password
    let password = passwordFromUI;
    if (password && password.length < 8) {
      return res.status(400).json({ error: "Mot de passe trop court (8 caractères minimum)." });
    }
    if (!password) password = randomPassword(14);

    // 1) Create (or get) Auth user
    let userId = "";
    let createdNewAuthUser = false;

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (!createErr && created?.user?.id) {
      userId = created.user.id;
      createdNewAuthUser = true;
    } else {
      if (createErr && looksLikeAlreadyRegistered(createErr)) {
        const existing = await findAuthUserByEmail(supabaseAdmin, email);
        if (!existing?.id) {
          return res.status(409).json({ error: "Email déjà enregistré mais utilisateur introuvable côté Auth." });
        }
        userId = existing.id;
        createdNewAuthUser = false;
      } else {
        return res.status(500).json({ error: createErr?.message || "Création Auth échouée." });
      }
    }

    // 2) Upsert profile
    const { error: profErr } = await supabaseAdmin
      .from("profiles")
      .upsert([{ user_id: userId, email, role }], { onConflict: "user_id" });

    if (profErr) return res.status(500).json({ error: profErr.message });

    // 3) Link to client (ignore duplication)
    const { error: linkErr } = await supabaseAdmin
      .from("client_users")
      .insert([{ client_id: clientId, user_id: userId }]);

    if (linkErr) {
      const msg = String(linkErr?.message || "").toLowerCase();
      const isDup = msg.includes("duplicate") || msg.includes("already exists") || msg.includes("unique");
      if (!isDup) return res.status(500).json({ error: linkErr.message });
    }

    // 4) Send invitation email
    let emailSent = false;
    let emailError = null;

    try {
      const appUrl = process.env.APP_URL || "https://app.evidencia.me";
      const mail = buildInviteEmail({
        appUrl,
        email,
        password,
        isNew: createdNewAuthUser,
      });

      // Si user existant, on n’envoie pas le password
      await sendEmail({
        to: email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });

      emailSent = true;
    } catch (e) {
      emailError = safeStr(e?.message || e);
    }

    return res.status(200).json({
      ok: true,
      user: { id: userId, email, role },
      existing: !createdNewAuthUser,
      createdNewAuthUser,
      tempPassword: createdNewAuthUser ? password : null,
      emailSent,
      emailError,
      note: createdNewAuthUser
        ? "Utilisateur créé et rattaché au client."
        : "Utilisateur déjà existant : rattaché au client.",
    });
  } catch (e) {
    const status = e?.status || 500;
    return res.status(status).json({ error: safeStr(e?.message) || "Erreur interne create-user." });
  }
}
