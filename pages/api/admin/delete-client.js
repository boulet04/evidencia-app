// pages/api/admin/delete-client.js
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
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // CORS (au cas où)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode non autorisée." });
    }

    // Vérif env
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant." });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant." });
    }

    // Auth admin via token
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Session invalide." });
    }

    const adminId = userData.user.id;

    // Vérifier rôle admin (IMPORTANT: role via profiles.role = 'admin')
    const { data: adminProfile, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", adminId)
      .maybeSingle();

    if (profErr) return res.status(500).json({ error: profErr.message });
    if (!adminProfile || adminProfile.role !== "admin") {
      return res.status(403).json({ error: "Accès interdit (admin requis)." });
    }

    const { clientId } = req.body || {};
    const cid = safeStr(clientId);
    if (!cid) return res.status(400).json({ error: "clientId manquant." });

    // 1) supprimer les liaisons client_users
    const { error: linkErr } = await supabaseAdmin
      .from("client_users")
      .delete()
      .eq("client_id", cid);

    if (linkErr) {
      return res.status(500).json({ error: `Suppression liaisons échouée: ${linkErr.message}` });
    }

    // 2) supprimer le client
    const { error: clientErr } = await supabaseAdmin
      .from("clients")
      .delete()
      .eq("id", cid);

    if (clientErr) {
      return res.status(500).json({ error: `Suppression client échouée: ${clientErr.message}` });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: safeStr(e?.message) || "Erreur interne." });
  }
}
