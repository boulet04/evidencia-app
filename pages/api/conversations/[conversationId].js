import { createClient } from "@supabase/supabase-js";

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export default async function handler(req, res) {
  const { conversationId } = req.query;

  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  if (!conversationId || typeof conversationId !== "string") {
    return res.status(400).json({ error: "Missing conversationId" });
  }

  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "Missing Bearer token" });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      error: "Server misconfiguration: missing SUPABASE env vars",
    });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: "Invalid token" });
  }

  const userId = userData.user.id;

  // Ownership check
  const { data: conv, error: convError } = await supabaseAdmin
    .from("conversations")
    .select("id,user_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (convError) return res.status(500).json({ error: convError.message });
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  if (conv.user_id !== userId) return res.status(403).json({ error: "Forbidden" });

  // Delete messages then conversation
  const { error: delMsgErr } = await supabaseAdmin
    .from("messages")
    .delete()
    .eq("conversation_id", conversationId);

  if (delMsgErr) return res.status(500).json({ error: delMsgErr.message });

  const { error: delConvErr } = await supabaseAdmin
    .from("conversations")
    .delete()
    .eq("id", conversationId);

  if (delConvErr) return res.status(500).json({ error: delConvErr.message });

  return res.status(204).end();
}
