import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// C'est cette ligne qui manque ou qui est mal nommée
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
