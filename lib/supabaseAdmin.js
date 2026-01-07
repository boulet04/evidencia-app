import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Le client Admin pour la gestion des utilisateurs
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

// Fonction de nettoyage (réclameé par l'admin)
export const safeStr = (str) => {
  if (!str) return "";
  return String(str).trim();
};

// Fonction de sécurité (réclameé par l'admin)
export const requireAdmin = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  const token = authHeader.split(" ")[1];
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  
  if (error || !user) {
    return res.status(401).json({ error: "Session invalide" });
  }
  return user;
};
