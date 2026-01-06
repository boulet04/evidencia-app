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

function isMissingColumnError(err) {
  const msg = safeStr(err?.message).toLowerCase();
  // PostgREST/Supabase renvoie souvent "column ... does not exist" ou similaire
  return msg.includes("column") && msg.includes("does not exist");
}

async function requireAdmin(token) {
  const { data: u, error: uErr } = await supabaseAdmin.auth.getUser(token);
  if (uErr || !u?.user) return { ok: false, status: 401, error: "Session invalide." };

  const { data: p, error: pErr } = await supabaseAdmin
    .from("profiles")
    .select("role, is_admin")
    .eq("user_id", u.user.id)
    .maybeSingle();

  if (pErr) return { ok: false, status: 500, error: pErr.message };

  const isAdmin = p?.role === "admin" || p?.is_admin === true;
  if (!isAdmin) return { ok: false, status: 403, error: "Accès interdit." };

  return { ok: true, userId: u.user.id };
}

async function insertClientWithFallback(name) {
  // On tente plusieurs colonnes possibles (d’après ton UI clientLabel)
  const tries = [
    { name },
    { company_name: name },
    { customer_name: name },
    { title: name },
  ];

  let lastErr = null;

  for (const payload of tries) {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .insert(payload)
      .select("*")
      .single();

    if (!error) return data;
    lastErr = error;

    // Si c’est une erreur "colonne inexistante", on tente la suivante
    if (isMissingColumnError(error)) continue;

    // Autres erreurs (contrainte NOT NULL, RLS, etc.) => on remonte directement
    break;
  }

  throw lastErr || new Error("Création client impossible.");
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

    const name = safeStr(req.body?.name).trim();
    if (!name) return res.status(400).json({ error: "Nom client obligatoire." });

    const client = await insertClientWithFallback(name);
    return res.status(200).json({ client });
  } catch (e) {
    console.error("create-client error:", e);
    return res.status(500).json({ error: safeStr(e?.message) || "Erreur interne." });
  }
}
