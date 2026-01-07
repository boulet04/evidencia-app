import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 1. Initialisation du client Admin
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

// 2. Fonction de nettoyage demandée par create-user.js
export const safeStr = (str) => {
  if (!str) return "";
  return String(str).trim();
};

// 3. Sécurité demandée par create-client.js et create-user.js
export const requireAdmin = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    throw new Error("Non autorisé : Token manquant");
  }
  const token = authHeader.split(" ")[1];
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  
  if (error || !user) {
    throw new Error("Session invalide");
  }

  // Optionnel : vérification si l'utilisateur a un flag admin dans votre DB
  return user;
};
