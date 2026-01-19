import { createClient } from "@supabase/supabase-js";

// Ces variables permettent à la console de lire vos utilisateurs et agents
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// C'est cette instance qui redonnera vie à vos listes d'admin
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

// Fonctions indispensables pour que les pages admin ne plantent pas au chargement
export const safeStr = (str) => {
  if (!str) return "";
  return String(str).trim();
};

export const requireAdmin = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) throw new Error("Non autorisé");
  const token = authHeader.split(" ")[1];
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) throw new Error("Session invalide");
  return user;
};
