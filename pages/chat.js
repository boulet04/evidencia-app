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

  // ---------- Helpers ----------
  function safeDecode(v) { try { return decodeURIComponent(v || ""); } catch { return v || ""; } }
  
  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
    });
  }

  // ---------- Database (Strictement calqué sur tes screens) ----------
  async function loadMessages(convId) {
    const { data, error } = await supabase
      .from("messages") 
      .select("*")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });
    
    if (error) console.error("Erreur messages:", error);
    return data || [];
  }

  async function loadHistory(uid, slug) {
    const { data, error } = await supabase
      .from("conversations")
      .select("*")
      .eq("user_id", uid)
      .eq("agent_slug", slug)
      .order("updated_at", { ascending: false });
    
    if (error) console.error("Erreur historique:", error);
    return data || [];
  }

  // ---------- Initialisation ----------
  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { window.location.href = "/login"; return; }
      
      const uid = session.user.id;
      setUserId(uid);
      setEmail(session.user.email);

      const url = new URL(window.location.href);
      const slug = safeDecode(url.searchParams.get("agent"));
      const cId = url.searchParams.get("c");

      // Charger l'agent
      const { data: ag } = await supabase.from("agents").select("*").eq("slug", slug).single();
      if (!ag) { window.location.href = "/agents"; return; }
      setAgent(ag);

      // Charger l'historique
      const h = await loadHistory(uid, slug);
      setHistory(h);

      // Charger la conversation
      if (cId) {
        setConversationId(cId);
        const msgs = await loadMessages(cId);
        setMessages(msgs.length > 0 ? msgs : [{ role: "assistant", content: `Bonjour, je suis ${ag.name}.` }]);
      } else if (h.length > 0) {
        window.location.href = `/chat?agent=${slug}&c=${h[0].id}`;
        return;
      }
      
      setLoading(false);
      setTimeout(scrollToBottom, 100);
    }
    init();
  }, []);

  // ---------- Actions ----------
  
  function openConversation(id) {
    if (id === conversationId) return;
    window.location.href = `/chat?agent=${agent.slug}&c=${id}`;
  }

  async function newConversation() {
    const { data } = await supabase.from("conversations").insert({
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

    // 1. Ajout local
    setMessages(prev => [...prev, { role: "user", content: text }]);
    scrollToBottom();

    // 2. Insertion dans table "messages" (Pas de user_id ici selon tes screens)
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: text
    });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ message: text, agentSlug: agent.slug })
      });
      
      const json = await res.json();
      const reply = json.reply || "Une erreur est survenue.";

      setMessages(prev => [...prev, { role: "assistant", content: reply }]);

      // 3. Insertion réponse IA
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "assistant",
        content: reply
      });

      // 4. Update conversations
      await supabase.from("conversations").update({ 
        updated_at: new Date().toISOString(),
        title: text.length > 25 ? text.slice(0, 25) + "..." : text 
      }).eq("id", conversationId);

      const h = await loadHistory(userId, agent.slug);
      setHistory(h);

    } catch (e) {
      console.error("Erreur envoi:", e);
    } finally {
      setSending(false);
      scrollToBottom();
    }
  }

  if (loading || !agent) return null;

  return (
    <main style={styles.page}>
      <div style={styles.bg}><div style={styles.bgLogo} /></div>

      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <button onClick={() => window.location.href="/agents"} style={styles.backBtn}>← Retour</button>
          <img src="/images/logolong.png" alt="logo" style={{ height: 25 }} />
          
          {/* AVATAR DE L'AGENT - EXACTEMENT SOUS TA FLÈCHE ROUGE */}
          <div style={styles.agentInfo}>
            <img 
              src={`/images/${agent.slug}.png`} 
              alt="avatar"
              style={styles.agentAvatar} 
            />
            <div>
              <div style={styles.agentName}>{agent.name}</div>
              <div style={styles.agentStatus}>Agent disponible</div>
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
            <span style={{ fontWeight: 900, fontSize: 12 }}>HISTORIQUE</span>
            <button onClick={newConversation} style={styles.newBtn}>+ Nouvelle</button>
          </div>
          <div style={styles.sidebarList}>
            {history.map(c => (
              <button key={c.id} onClick={() => openConversation(c.id)} style={{
                ...styles.histItem,
                backgroundColor: c.id === conversationId ? "rgba(255,140,40,0.1)" : "transparent",
                border: c.id === conversationId ? "1px solid rgba(255,140,40,0.3)" : "1px solid transparent"
              }}>
                <div style={styles.histTitle}>{c.title || "Conversation"}</div>
                <div style={styles.histDate}>{new Date(c.updated_at).toLocaleDateString()}</div>
              </button>
            ))}
          </div>
        </aside>

        <div style={styles.chatCard}>
          <div style={styles.thread} ref={threadRef}>
            {messages.map((m, i) => (
              <div key={i} style={{ 
                ...styles.bubble, 
                alignSelf: m.role === "user" ? "flex-end" : "flex-start", 
                backgroundColor: m.role === "user" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.5)" 
              }}>
                <div style={styles.bubbleRole}>{m.role === "user" ? "VOUS" : agent.name.toUpperCase()}</div>
                <div style={styles.bubbleText}>{m.content}</div>
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
  page: { minHeight: "100vh", background: "#05060a", color: "#fff", fontFamily: "sans-serif", overflow: "hidden" },
  bg: { position: "absolute", inset: 0, zIndex: 0 },
  bgLogo: { position: "absolute", inset: 0, backgroundImage: "url('/images/logopc.png')", backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat", opacity: 0.03 },
  topbar: { position: "relative", zIndex: 2, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px", background: "rgba(0,0,0,0.8)", borderBottom: "1px solid rgba(255,255,255,0.1)" },
  topLeft: { display: "flex", alignItems: "center", gap: 20 },
  topRight: { display: "flex", alignItems: "center", gap: 15 },
  agentInfo: { display: "flex", alignItems: "center", gap: 12, marginLeft: 15 },
  agentAvatar: { width: 45, height: 45, borderRadius: "50%", border: "2px solid #ff8c28", objectFit: "cover", objectPosition: "center 20%" },
  agentName: { fontWeight: 800, fontSize: 14 },
  agentStatus: { fontSize: 10, color: "#aaa" },
  backBtn: { background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", padding: "8px 15px", borderRadius: 20, cursor: "pointer", fontWeight: 700, fontSize: 12 },
  userChip: { background: "rgba(255,255,255,0.05)", padding: "5px 12px", borderRadius: 15, fontSize: 11 },
  btnGhost: { background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", padding: "5px 12px", borderRadius: 15, cursor: "pointer", fontSize: 11 },
  layout: { position: "relative", zIndex: 2, display: "grid", gridTemplateColumns: "280px 1fr", gap: 20, padding: 20, height: "calc(100vh - 70px)" },
  sidebar: { background: "rgba(0,0,0,0.4)", borderRadius: 20, border: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column" },
  sidebarTop: { padding: "20px", display: "flex", justifyContent: "space-between", alignItems: "center" },
  newBtn: { background: "#fff", color: "#000", border: "none", padding: "6px 12px", borderRadius: 10, fontSize: 11, fontWeight: 800, cursor: "pointer" },
  sidebarList: { flex: 1, overflowY: "auto", padding: 10 },
  histItem: { width: "100%", textAlign: "left", padding: "12px", borderRadius: 15, color: "#fff", cursor: "pointer", marginBottom: 8 },
  histTitle: { fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  histDate: { fontSize: 9, opacity: 0.4, marginTop: 4 },
  chatCard: { background: "rgba(0,0,0,0.2)", borderRadius: 25, border: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", overflow: "hidden" },
  thread: { flex: 1, overflowY: "auto", padding: "25px", display: "flex", flexDirection: "column", gap: 20 },
  bubble: { maxWidth: "80%", padding: "15px 20px", borderRadius: 20, border: "1px solid rgba(255,255,255,0.03)" },
  bubbleRole: { fontSize: 9, opacity: 0.5, marginBottom: 5, fontWeight: 800 },
  bubbleText: { fontSize: 14, lineHeight: 1.5 },
  composer: { padding: "20px", background: "rgba(0,0,0,0.4)", display: "flex", gap: 12 },
  textarea: { flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 15, padding: 15, color: "#fff", resize: "none", fontSize: 14 },
  sendBtn: { background: "#ff8c28", border: "none", color: "#fff", padding: "0 25px", borderRadius: 15, fontWeight: 800, cursor: "pointer" },
  sendBtnDisabled: { background: "#222", color: "#555", border: "none", padding: "0 25px", borderRadius: 15, cursor: "not-allowed" }
};
