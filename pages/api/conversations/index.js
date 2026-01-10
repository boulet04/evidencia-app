// pages/api/conversations/index.js
import { supabaseAdmin } from "../../../lib/supabaseAdmin";

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const { data: authData, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !authData?.user) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const user = authData.user;

    const agent_slug = (req.body?.agent_slug || "").toString().trim();
    const title = (req.body?.title || "").toString().trim();

    if (!agent_slug) {
      return res.status(400).json({ error: "Missing agent_slug" });
    }

    const finalTitle = title || "Nouvelle conversation";

    const { data: conv, error: insertErr } = await supabaseAdmin
      .from("conversations")
      .insert({
        user_id: user.id,
        agent_slug,
        title: finalTitle,
        archived: false,
      })
      .select("id,title,created_at,agent_slug")
      .single();

    if (insertErr) {
      return res.status(500).json({ error: insertErr.message });
    }

    return res.status(200).json({ conversation: conv });
  } catch (e) {
    console.error("API /conversations error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
