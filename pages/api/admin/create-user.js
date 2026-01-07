// pages/api/admin/create-user.js
import { requireAdmin, safeStr, supabaseAdmin } from "../../../lib/supabaseAdmin";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

    const auth = await requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const { clientId, email, password, role } = req.body || {};
    const client_id = safeStr(clientId).trim();
    const userEmail = safeStr(email).trim().toLowerCase();
    const userPassword = safeStr(password);
    const userRole = safeStr(role).trim().toLowerCase() || "user";

    if (!client_id) return res.status(400).json({ error: "clientId manquant." });
    if (!userEmail) return res.status(400).json({ error: "Email manquant." });
    if (!userPassword || userPassword.length < 6) {
      return res.status(400).json({ error: "Mot de passe invalide (min 6 caractères)." });
    }
    if (!["user", "admin"].includes(userRole)) {
      return res.status(400).json({ error: "Role invalide (user|admin)." });
    }

    const sb = supabaseAdmin();

    // 1) Vérifier que le client existe
    const { data: client, error: cErr } = await sb
      .from("clients")
      .select("id, name")
      .eq("id", client_id)
      .maybeSingle();

    if (cErr) return res.status(500).json({ error: `Erreur clients: ${cErr.message}` });
    if (!client) return res.status(404).json({ error: "Client introuvable." });

    // 2) Créer l’utilisateur Auth (service role)
    const { data: created, error: createErr } = await sb.auth.admin.createUser({
      email: userEmail,
      password: userPassword,
      email_confirm: true,
    });

    if (createErr) return res.status(500).json({ error: `Auth createUser: ${createErr.message}` });

    const newUserId = created?.user?.id;
    if (!newUserId) return res.status(500).json({ error: "Création Auth OK mais user.id manquant." });

    // 3) Créer/mettre à jour profiles (compat role + is_admin)
    const is_admin = userRole === "admin";

    const { error: pErr } = await sb
      .from("profiles")
      .upsert(
        {
          user_id: newUserId,
          email: userEmail,
          role: userRole,
          is_admin,
        },
        { onConflict: "user_id" }
      );

    if (pErr) return res.status(500).json({ error: `profiles upsert: ${pErr.message}` });

    // 4) Lier au client
    const { error: linkErr } = await sb
      .from("client_users")
      .insert({ client_id, user_id: newUserId });

    if (linkErr) return res.status(500).json({ error: `client_users insert: ${linkErr.message}` });

    return res.status(200).json({
      user: { user_id: newUserId, email: userEmail, role: userRole, is_admin },
      client: { id: client.id, name: client.name },
    });
  } catch (e) {
    console.error("API create-user error:", e);
    return res.status(500).json({ error: "Erreur interne create-user." });
  }
}
