import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Initialisation du client Admin
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

// La fonction manquante réclamée par l'erreur
export const safeStr = (str) => {
  if (!str) return "";
  return String(str).trim();
};
