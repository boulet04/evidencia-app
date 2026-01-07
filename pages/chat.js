import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Chat() {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [agent, setAgent] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [history, setHistory] = useState([]);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const threadRef = useRef(null);
  const canSend = useMemo(() => input.trim().length > 0 && !sending, [input, sending]);

  function safeDecode(v) { try { return decodeURIComponent(v || ""); } catch { return v || ""; } }
  function scrollToBottom() { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; }

  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { window.location.href = "/login"; return; }
      setUserId(session.user.id);
      setEmail(session.user.email);

      const url = new URL(window.location.href);
      const slug = safeDecode(url.searchParams.get("agent"));
      const cId = url.searchParams.get("c");

      const { data: ag } = await supabase.from("agents").select("*").eq("slug", slug).single();
      setAgent(ag);

      const { data: h } = await supabase.from("conversations").select("*").eq("user_id", session.user.id).eq("agent_slug", slug).order("updated_at", { ascending: false });
      setHistory(h || []);

      if (cId) {
        setConversationId(cId);
        const { data: msgs } = await supabase.from("messages").select("*").eq("conversation_id", cId).order("created_at", { ascending: true });
        setMessages(msgs || []);
      }
      setLoading(false);
      setTimeout(scrollToBottom, 100);
    }
    init();
  }, []);

  async function sendMessage() {
    if (!canSend) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    const tempMessages = [...messages, { role: "user", content: text }];
    setMessages(tempMessages);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ message: text, agentSlug: agent.slug, conversationId: conversationId })
      });
      const json = await res.json();
      if (json.reply) setMessages([...tempMessages, { role: "assistant", content: json.reply }]);
    } catch (e) { console.error(e); } finally { setSending(false); setTimeout(scrollToBottom, 50); }
  }

  if (loading || !agent) return null;

  return (
    <main style={{ minHeight: "100vh", background: "#05060a", color: "#fff", display: "flex", flexDirection: "column" }}>
      <header style={{ height: 60, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 20px", borderBottom: "1px solid #111" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
          <button onClick={() => window.location.href="/agents"} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer" }}>←</button>
          <img src="/images/logolong.png" style={{ height: 25 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 15, borderLeft: "1px solid #222", paddingLeft: 15 }}>
            <img src={`/images/${agent.slug}.png`} style={{ width: 35, height: 35, borderRadius: "50%", border: "1px solid #ff8c28", objectFit: "cover" }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: "bold" }}>{agent.name}</div>
              <div style={{ fontSize: 10, color: "#4caf50" }}>En ligne</div>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
          <span style={{ fontSize: 11, opacity: 0.5 }}>{email}</span>
          <button onClick={() => supabase.auth.signOut()} style={{ background: "none", border: "none", color: "#ff4d4d", fontSize: 11, cursor: "pointer" }}>Déconnexion</button>
        </div>
      </header>

      <section style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <aside style={{ width: 260, borderRight: "1px solid #111", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: "bold" }}>Conversations</span>
            <button onClick={() => window.location.href=`/chat?agent=${agent.slug}`} style={{ background: "#fff", border: "none", borderRadius: 5, width: 24, height: 24, cursor: "pointer" }}>+</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 10px" }}>
            {history.map(c => (
              <div key={c.id} onClick={() => window.location.href=`/chat?agent=${agent.slug}&c=${c.id}`} style={{ padding: "12px 15px", borderRadius: 8, cursor: "pointer", marginBottom: 5, background: c.id === conversationId ? "#1a1a1a" : "transparent" }}>
                <div style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.title || "Sans titre"}</div>
                <div style={{ fontSize: 9, opacity: 0.3, marginTop: 4 }}>{new Date(c.updated_at).toLocaleDateString()}</div>
              </div>
            ))}
          </div>
        </aside>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "url('/images/bg-pattern.png')" }}>
          <div ref={threadRef} style={{ flex: 1, overflowY: "auto", padding: "40px 15%", display: "flex", flexDirection: "column", gap: 20 }}>
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "80%" }}>
                <div style={{ fontSize: 9, fontWeight: "bold", marginBottom: 5, opacity: 0.5, textAlign: m.role === "user" ? "right" : "left" }}>{m.role === "user" ? "VOUS" : agent.name.toUpperCase()}</div>
                <div style={{ padding: "12px 18px", borderRadius: 15, background: m.role === "user" ? "#111" : "rgba(255,255,255,0.05)", fontSize: 14 }}>{m.content}</div>
              </div>
            ))}
          </div>
          <div style={{ padding: "20px 15%", display: "flex", gap: 10 }}>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if(e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }} placeholder={`Écrire à ${agent.name}...`} style={{ flex: 1, background: "#111", border: "1px solid #222", borderRadius: 10, padding: 15, color: "#fff", resize: "none", height: 50 }} />
            <button disabled={!canSend} onClick={sendMessage} style={{ background: canSend ? "#ff8c28" : "#222", border: "none", padding: "0 20px", borderRadius: 10, color: "#fff", fontWeight: "bold", cursor: canSend ? "pointer" : "default" }}>Envoyer</button>
          </div>
        </div>
      </section>
    </main>
  );
}
