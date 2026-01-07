import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  // IMPORTANT: chez vous la variable s'appelle sur Vercel "SUPABASE_SERVICE_ROLE_KEY"
  // Si chez vous elle est "SUPABASE_SERVICE_ROLE_KEY" c'est OK.
  // Ici je supporte les 2 noms pour éviter tout blocage.
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
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

// Pages Router: pour accepter un JSON base64 “gros”
export const config = {
  api: { bodyParser: { sizeLimit: "25mb" } },
};

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // CORS (utile si jamais)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  try {
    // Vérifs env
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant." });
    }
    const srk = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!srk) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant." });
    }

    // Auth admin
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide." });

    const adminId = userData.user.id;

    const { data: profile, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", adminId)
      .maybeSingle();

    if (profErr) return res.status(500).json({ error: profErr.message });
    if (!profile || profile.role !== "admin") {
      return res.status(403).json({ error: "Accès interdit (admin requis)." });
    }

    // Payload
    const { userId, agentSlug, fileName, base64, mimeType } = req.body || {};
    const uid = safeStr(userId);
    const slug = safeStr(agentSlug);
    const name = safeStr(fileName);
    const mime = safeStr(mimeType) || "application/pdf";

    if (!uid) return res.status(400).json({ error: "userId manquant." });
    if (!slug) return res.status(400).json({ error: "agentSlug manquant." });
    if (!name) return res.status(400).json({ error: "fileName manquant." });
    if (!base64) return res.status(400).json({ error: "base64 manquant." });

    // Decode base64
    const b64 = base64.includes(",") ? base64.split(",").pop() : base64;
    const buffer = Buffer.from(b64, "base64");

    const ts = Date.now();
    const safeName = name.replace(/[^\w.\-()\s]/g, "_");
    const path = `${uid}/${slug}/${ts}_${safeName}`;

    const { data: upData, error: upErr } = await supabaseAdmin.storage
      .from("agent_sources")
      .upload(path, buffer, { contentType: mime, upsert: false });

    if (upErr) return res.status(500).json({ error: upErr.message });

    return res.status(200).json({
      ok: true,
      path: upData?.path || path,
      mime,
      name: safeName,
      size: buffer.length,
    });
  } catch (e) {
    return res.status(500).json({ error: safeStr(e?.message) || "Erreur interne." });
  }
}
