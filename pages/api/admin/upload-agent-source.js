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

function getExt(fileName) {
  const n = safeStr(fileName);
  const i = n.lastIndexOf(".");
  if (i === -1) return "";
  return n.slice(i + 1).toLowerCase();
}

function inferMimeFromExt(ext) {
  const map = {
    pdf: "application/pdf",
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",

    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",


    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",

    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  return map[ext] || "application/octet-stream";
}

// Autorisations (tu peux en ajouter)
const ALLOWED_EXT = new Set([
  "pdf",
  "csv",
  "txt",
  "md",
  "json",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "png",
  "jpg",
  "jpeg",
  "webp",
]);

const ALLOWED_MIME = new Set([
  "application/pdf",
  "text/csv",
  "application/csv",
  "text/plain",
  "text/markdown",
  "application/json",

  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",


  "image/png",
  "image/jpeg",
  "image/webp",

  // toléré si extension ok
  "application/octet-stream",
]);

export const config = {
  api: { bodyParser: { sizeLimit: "25mb" } },
};

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }

  try {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return res.status(500).json({ error: "NEXT_PUBLIC_SUPABASE_URL manquant." });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY manquant." });
    }

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

    const { userId, agentSlug, fileName, base64, mimeType } = req.body || {};

    const uid = safeStr(userId);
    const slug = safeStr(agentSlug);

    const rawName = safeStr(fileName);
    const safeName = rawName
      .replace(/[/\\]+/g, "_")
      .replace(/[^\w.\-()\s]/g, "_")
      .replace(/^\.+/g, "");

    const ext = getExt(safeName);

    if (!uid) return res.status(400).json({ error: "userId manquant." });
    if (!slug) return res.status(400).json({ error: "agentSlug manquant." });
    if (!safeName) return res.status(400).json({ error: "fileName manquant." });
    if (!base64) return res.status(400).json({ error: "base64 manquant." });

    if (!ext || !ALLOWED_EXT.has(ext)) {
      return res.status(415).json({
        error: "Type de fichier non supporté.",
        details: `Extension .${ext || "?"} refusée.`,
        allowed: Array.from(ALLOWED_EXT),
      });
    }

    const b64 = base64.includes(",") ? base64.split(",").pop() : base64;
    const buffer = Buffer.from(b64, "base64");
    if (!buffer?.length) return res.status(400).json({ error: "Fichier vide ou base64 invalide." });

    const providedMime = safeStr(mimeType).toLowerCase();
    const inferredMime = inferMimeFromExt(ext);

    const isGeneric =
      !providedMime ||
      providedMime === "application/octet-stream" ||
      providedMime === "binary/octet-stream";

    const finalMime = isGeneric ? inferredMime : providedMime;

    if (!ALLOWED_MIME.has(finalMime) && finalMime !== inferredMime) {
      return res.status(415).json({
        error: "MIME non supporté.",
        details: `mimeType=${finalMime}`,
      });
    }

    const ts = Date.now();
    const path = `${uid}/${slug}/${ts}_${safeName}`;

    const { data: upData, error: upErr } = await supabaseAdmin.storage
      .from("agent_sources")
      .upload(path, buffer, { contentType: finalMime, upsert: false });

    if (upErr) return res.status(500).json({ error: upErr.message });

    return res.status(200).json({
      ok: true,
      path: upData?.path || path,
      mime: finalMime,
      name: safeName,
      ext,
      size: buffer.length,
    });
  } catch (e) {
    return res.status(500).json({ error: safeStr(e?.message) || "Erreur interne." });
  }
}
