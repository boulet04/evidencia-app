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
  const [errorMsg, setErrorMsg] = useState("");

  const threadRef = useRef(null);
  const canSend = useMemo(() => input.trim().length > 0 && !sending, [input, sending]);

  // ---------- Helpers ----------
  function safeDecode(v) { try { return decodeURIComponent(v || ""); } catch { return v || ""; } }
  
  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
    });
  }

  function getAgentAvatar() {
    if (!agent) return "/images/logopc.png";
    return `/images/${agent.slug}.png`;
  }

  // ---------- Database Calls ----------
  async function fetchMessages(uid, convId) {
    const { data, error } = await supabase
      .from("conversation_messages")
      .select("*")
      .eq("user_id", uid)
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });
    return error ? [] : data;
  }

  async function fetchHistory(uid, slug) {
    const { data, error } = await supabase
      .from("conversations")
      .select("*")
      .eq("user_id", uid)
      .eq("agent_slug", slug)
      .order("updated_at", { ascending: false });
    return error ? [] : data;
  }

  // ---------- Core Logic ----------
  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { window.location.href = "/login"; return; }
      
      const uid = session.user.id;
      setUserId(uid);
      setEmail(session.user.email);

      const url = new URL(window.location.href);
      const slug = safeDecode(url.searchParams.get("agent"));
      const convId = url.searchParams.get("c");

      // Charger l'agent
      const { data: ag } = await supabase.from("agents").select("*").eq("slug", slug).single();
      if (!ag) { window.location.href = "/agents"; return; }
      setAgent(ag);

      // Charger l'historique
      const h = await fetchHistory(uid, slug);
      setHistory(h);

      if (convId) {
        setConversationId(convId);
        const msgs = await fetchMessages(uid, convId);
        setMessages(msgs.length > 0 ? msgs : [{ role: "assistant", content: `Bonjour, je suis ${ag.name}.` }]);
      } else if (h.length > 0) {
        // Rediriger vers la dernière conv si aucune n'est sélectionnée
        window.location.href = `/chat?agent=${slug}&c=${h[0].id}`;
      } else {
        setMessages([{ role: "assistant", content: `Bonjour, je suis ${ag.name}.` }]);
      }
      setLoading(false);
      scrollToBottom();
    }
    init();
  }, []);

  // REPARATION HISTORIQUE : Cette fonction change maintenant l'URL pour forcer le rechargement
  async function openConversation(id) {
    window.location.href = `/chat?agent=${agent.slug}&c=${id}`;
  }

  async function newConversation() {
    const { data, error } = await supabase.from("conversations").insert({
      user_id: userId,
      agent_slug: agent.slug,
      title: "Nouvelle conversation"
    }).select().single();
    if (data) window.location.href = `/chat?agent=${agent.slug}&c=${data.id}`;
  }

  async function sendMessage() {
    if (!canSend || !conversationId) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    const newMsgs = [...messages, { role: "user", content: text }];
    setMessages(newMsgs);
    scrollToBottom();

    // Sauvegarde Supabase
    await supabase.from("conversation_messages").insert({
      user_id: userId,
      conversation_id: conversationId,
      role: "user",
      content: text
    });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ message: text, agentSlug: agent.slug })
      });
      const json = await res.json();
      const reply = json.reply || "Désolé, j'ai rencontré une erreur.";

      setMessages([...newMsgs, { role: "assistant", content: reply }]);
      await supabase.from("conversation_messages").insert({
        user_id: userId,
        conversation_id: conversationId,
        role: "assistant",
        content: reply
      });
      await supabase.from("conversations").update({ updated_at: new Date(), title: text.slice(0, 30) }).eq("id", conversationId);
    } catch (e) {
      console.error(e);
    } finally {
      setSending(false);
      scrollToBottom();
    }
  }

  if (loading || !agent) return null;

  return (
    <main style={styles.page}>
      <div style={styles.bg}><div style={styles.bgLogo} /><div style={styles.bgVeils} /></div>

      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <button onClick={() => window.location.href="/agents"} style={styles.backBtn}>← Retour</button>
          <img src="/images/logolong.png" alt="logo" style={{ height: 25 }} />
          
          {/* BULLE AGENT (Ta flèche rouge) */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 20 }}>
            <img 
              src={getAgentAvatar()} 
              style={{ width: 45, height: 45, borderRadius: "50%", border: "2px solid #ff8c28", objectFit: "cover", objectPosition: "center 20%" }} 
            />
            <div>
              <div style={{ fontWeight: 900, fontSize: 14 }}>{agent.name}</div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>Agent disponible</div>
            </div>
          </div>
        </div>
        <div style={styles.topRight}>
          <span style={styles.userChip}>{email}</span>
          <button onClick={() => supabase.auth.signOut()} style={styles.btnGhost}>Déconnexion</button>
        </div>
      </header>

      <section style={styles.layout}>
        <aside style={styles.sidebar}>
          <div style={styles.sidebarTop}>
            <span style={{ fontWeight: 900 }}>Historique</span>
            <button onClick={newConversation} style={styles.newBtn}>+ Nouvelle</button>
          </div>
          <div style={styles.sidebarList}>
            {history.map(c => (
              <button key={c.id} onClick={() => openConversation(c.id)} style={{
                ...styles.histItem,
                backgroundColor: c.id === conversationId ? "rgba(255,140,40,0.2)" : "transparent"
              }}>
                {c.title || "Sans titre"}
              </button>
            ))}
          </div>
        </aside>

        <div style={styles.chatCard}>
          <div style={styles.thread} ref={threadRef}>
            {messages.map((m, i) => (
              <div key={i} style={{ ...styles.bubble, alignSelf: m.role === "user" ? "flex-end" : "flex-start", backgroundColor: m.role === "user" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.3)" }}>
                <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 4 }}>{m.role === "user" ? "Vous" : agent.name}</div>
                <div>{m.content}</div>
              </div>
            ))}
          </div>
          <div style={styles.composer}>
            <textarea 
              value={input} 
              onChange={(e) => setInput(e.target.value)} 
              onKeyDown={(e) => { if(e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              style={styles.textarea} 
              placeholder="Écrivez votre message..."
            />
            <button disabled={!canSend} onClick={sendMessage} style={canSend ? styles.sendBtn : styles.sendBtnDisabled}>
              {sending ? "..." : "Envoyer"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

const styles = {
  page: { minHeight: "100vh", position: "relative", background: "#05060a", color: "#fff", fontFamily: "Segoe UI, sans-serif", overflow: "hidden" },
  bg: { position: "absolute", inset: 0, zIndex: 0 },
  bgLogo: { position: "absolute", inset: 0, backgroundImage: "url('/images/logopc.png')", backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat", opacity: 0.05 },
  bgVeils: { position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(0,0,0,0.4), transparent)" },
  topbar: { position: "relative", zIndex: 2, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px", background: "rgba(0,0,0,0.5)", borderBottom: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(10px)" },
  topLeft: { display: "flex", alignItems: "center", gap: 15 },
  topRight: { display: "flex", alignItems: "center", gap: 15 },
  backBtn: { background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", padding: "8px 15px", borderRadius: 20, cursor: "pointer", fontWeight: 700 },
  userChip: { background: "rgba(255,255,255,0.05)", padding: "5px 12px", borderRadius: 15, fontSize: 12 },
  btnGhost: { background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", padding: "5px 12px", borderRadius: 15, cursor: "pointer" },
  layout: { position: "relative", zIndex: 2, display: "grid", gridTemplateColumns: "260px 1fr", gap: 20, padding: 20, height: "calc(100vh - 70px)" },
  sidebar: { background: "rgba(0,0,0,0.3)", borderRadius: 20, border: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column" },
  sidebarTop: { padding: 20, display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.05)" },
  newBtn: { background: "#fff", color: "#000", border: "none", padding: "5px 10px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer" },
  sidebarList: { flex: 1, overflowY: "auto", padding: 10 },
  histItem: { width: "100%", textAlign: "left", padding: "12px", borderRadius: 12, border: "none", color: "#fff", cursor: "pointer", marginBottom: 5, fontSize: 13 },
  chatCard: { background: "rgba(0,0,0,0.2)", borderRadius: 25, border: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", overflow: "hidden" },
  thread: { flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 15 },
  bubble: { maxWidth: "75%", padding: "12px 18px", borderRadius: 20, fontSize: 14, lineHeight: 1.5 },
  composer: { padding: 20, background: "rgba(0,0,0,0.3)", display: "flex", gap: 10 },
  textarea: { flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 15, padding: 12, color: "#fff", resize: "none" },
  sendBtn: { background: "linear-gradient(135deg, #ff8c28, #5078ff)", border: "none", color: "#fff", padding: "0 20px", borderRadius: 15, fontWeight: 900, cursor: "pointer" },
  sendBtnDisabled: { background: "#333", color: "#666", border: "none", padding: "0 20px", borderRadius: 15, cursor: "not-allowed" }
};
