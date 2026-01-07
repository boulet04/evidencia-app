// pages/api/admin/create-client.js
import { requireAdmin, safeStr, supabaseAdmin } from "../../../lib/supabaseAdmin";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

    const auth = await requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const { name } = req.body || {};
    const clientName = safeStr(name).trim();

    if (!clientName) return res.status(400).json({ error: "Nom de client manquant." });

    const sb = supabaseAdmin();

    const { data, error } = await sb
      .from("clients")
      .insert({ name: clientName })
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ client: data });
  } catch (e) {
    console.error("API create-client error:", e);
    return res.status(500).json({ error: "Erreur interne create-client." });
  }
}
