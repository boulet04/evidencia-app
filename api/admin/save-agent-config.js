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
  return (v ?? "").toString();
}

export default async function handler(req, res) {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Token manquant." });

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: "Session invalide." });

    const adminId = userData.user.id;
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("user_id", adminId)
      .maybeSingle();

    if (!profile || profile.role !== "admin") {
      return res.status(403).json({ error: "Accès interdit (admin requis)." });
    }

    const { userId, agentId, systemPrompt, context, contextJson } = req.body || {};
    const uid = (userId || "").toString().trim();
    const aid = (agentId || "").toString().trim();

    if (!uid) return res.status(400).json({ error: "userId manquant." });
    if (!aid) return res.status(400).json({ error: "agentId manquant." });

    let ctx = {};
    if (context && typeof context === "object") {
      ctx = context;
    } else if (typeof contextJson === "string") {
      try {
        ctx = contextJson ? JSON.parse(contextJson) : {};
      } catch {
        return res.status(400).json({ error: "contextJson invalide (JSON requis)." });
      }
    }

    const payload = {
      user_id: uid,
      agent_id: aid,
      system_prompt: safeStr(systemPrompt || "").trim(),
      context: ctx,
    };

    const { error } = await supabaseAdmin
      .from("client_agent_configs")
      .upsert(payload, { onConflict: "user_id,agent_id" });

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: safeStr(e?.message) || "Erreur interne." });
  }
}
