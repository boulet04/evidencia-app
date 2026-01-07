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

export default async function handler(req, res) {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

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

    const { userId, agentId, assign } = req.body || {};
    const uid = safeStr(userId);
    const aid = safeStr(agentId);
    const doAssign = !!assign;

    if (!uid) return res.status(400).json({ error: "userId manquant." });
    if (!aid) return res.status(400).json({ error: "agentId manquant." });

    if (doAssign) {
      const { error } = await supabaseAdmin.from("user_agents").insert([
        { user_id: uid, agent_id: aid }
      ]);
      // si déjà existant, ignorez l'erreur de duplication si vous avez une contrainte unique
      if (error && !String(error.message || "").toLowerCase().includes("duplicate")) {
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ ok: true, assigned: true });
    } else {
      const { error } = await supabaseAdmin
        .from("user_agents")
        .delete()
        .eq("user_id", uid)
        .eq("agent_id", aid);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, assigned: false });
    }
  } catch (e) {
    return res.status(500).json({ error: safeStr(e?.message) || "Erreur interne." });
  }
}
