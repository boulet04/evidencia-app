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

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
    });
  }

  // 1. CHARGEMENT DE L'HISTORIQUE RÉEL
  async function loadHistory(uid, slug) {
    const { data } = await supabase
      .from("conversations")
      .select("*")
      .eq("user_id", uid)
      .eq("agent_slug", slug)
      .order("updated_at", { ascending: false });
    return data || [];
  }

  // 2. CHARGEMENT DES MESSAGES D'UNE CONVERSATION
  async function loadMessages(convId) {
    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });
    return data || [];
  }

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

      if (cId) {
        setConversationId(cId);
        const msgs = await loadMessages(cId);
        setMessages(msgs.length > 0 ? msgs : [{ role: "assistant", content: `Bonjour, je suis ${ag.name}. Comment puis-je vous aider ?` }]);
      } else if (h.length > 0) {
        // Redirection vers la dernière conversation existante si aucune n'est sélectionnée
        window.location.href = `/chat?agent=${slug}&c=${h[0].id}`;
        return;
      } else {
        // Créer une nouvelle conversation si l'historique est vide
        const { data: newConv } = await supabase.from("conversations").insert({
          user_id: uid,
          agent_slug: slug,
          title: "Nouvelle conversation"
        }).select().single();
        if (newConv) window.location.href = `/chat?agent=${slug}&c=${newConv.id}`;
      }
      setLoading(false);
      setTimeout(scrollToBottom, 100);
    }
    init();
  }, []);

  // 3. ENVOI DE MESSAGE (LIÉ À TON API)
  async function sendMessage() {
    if (!canSend || !conversationId) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    const newMsgs = [...messages, { role: "user", content: text }];
    setMessages(newMsgs);
    scrollToBottom();

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json", 
          Authorization: `Bearer ${session?.access_token}` 
        },
        body: JSON.stringify({ 
          message: text, 
          agentSlug: agent.slug,
          conversationId: conversationId 
        })
      });
      
      const json = await res.json();
      if (json.reply) {
        setMessages([...newMsgs, { role: "assistant", content: json.reply }]);
        // Rafraîchir l'historique pour mettre à jour les titres et dates
        const updatedHistory = await loadHistory(userId, agent.slug);
        setHistory(updatedHistory);
      }
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
      {/* TOPBAR AVEC LOGO ET AVATAR AGENT */}
      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <button onClick={() => window.location.href="/agents"} style={styles.backBtn}>←</button>
          <img src="/images/logolong.png" alt="logo" style={{ height: 22 }} />
          
          <div style={styles.agentHeader}>
            <img 
              src={`/images/${agent.slug}.png`} 
              style={styles.agentAvatar} 
              alt={agent.name}
            />
            <div>
              <div style={styles.agentName}>{agent.name}</div>
              <div style={styles.agentStatus}>En ligne</div>
            </div>
          </div>
        </div>
        <div style={styles.topRight}>
          <span style={styles.userEmail}>{email}</span>
          <button onClick={() => supabase.auth.signOut()} style={styles.logoutBtn}>Déconnexion</button>
        </div>
      </header>

      <section style={styles.layout}>
        {/* SIDEBAR HISTORIQUE */}
        <aside style={styles.sidebar}>
          <div style={styles.sidebarHeader}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Conversations</span>
            <button 
              onClick={() => window.location.href=`/chat?agent=${agent.slug}`} 
              style={styles.newChatBtn}
            >
              +
            </button>
          </div>
          <div style={styles.historyList}>
            {history.map(c => (
              <button 
                key={c.id} 
                onClick={() => window.location.href=`/chat?agent=${agent.slug}&c=${c.id}`}
                style={{
                  ...styles.historyItem,
                  backgroundColor: c.id === conversationId ? "rgba(255,140,40,0.15)" : "transparent",
                  border: c.id === conversationId ? "1px solid rgba(255,140,40,0.3)" : "1px solid transparent"
                }}
              >
                <div style={styles.historyTitle}>{c.title || "Sans titre"}</div>
                <div style={styles.historyDate}>{new Date(c.updated_at).toLocaleDateString()}</div>
              </button>
            ))}
          </div>
        </aside>

        {/* ZONE DE CHAT */}
        <div style={styles.chatContainer}>
          <div style={styles.messagesThread} ref={threadRef}>
            {messages.map((m, i) => (
              <div key={i} style={{
                ...styles.messageBubble,
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                backgroundColor: m.role === "user" ? "#ff8c28" : "rgba(255,255,255,0.05)",
                color: m.role === "user" ? "#fff" : "#eee"
              }}>
                <div style={styles.roleLabel}>{m.role === "user" ? "Vous" : agent.name}</div>
                <div>{m.content}</div>
              </div>
            ))}
            {sending && <div style={styles.loadingStatus}>{agent.name} écrit...</div>}
          </div>

          <div style={styles.inputArea}>
            <textarea 
              value={input} 
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if(e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder={`Parlez avec ${agent.name}...`}
              style={styles.inputField}
            />
            <button 
              disabled={!canSend} 
              onClick={sendMessage} 
              style={canSend ? styles.sendBtn : styles.sendBtnDisabled}
            >
              Envoyer
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

const styles = {
  page: { height: "100vh", background: "#05060a", color: "#fff", fontFamily: "Inter, sans-serif", display: "flex", flexDirection: "column" },
  topbar: { height: 70, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 20px", borderBottom: "1px solid rgba(255,255,255,0.05)", background: "#05060a" },
  topLeft: { display: "flex", alignItems: "center", gap: 20 },
  topRight: { display: "flex", alignItems: "center", gap: 15 },
  agentHeader: { display: "flex", alignItems: "center", gap: 12, marginLeft: 20, paddingLeft: 20, borderLeft: "1px solid rgba(255,255,255,0.1)" },
  agentAvatar: { width: 40, height: 40, borderRadius: "50%", border: "2px solid #ff8c28", objectFit: "cover", objectPosition: "center 20%" },
  agentName: { fontWeight: 700, fontSize: 14 },
  agentStatus: { fontSize: 10, color: "#4caf50" },
  backBtn: { background: "none", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", padding: "5px 10px", borderRadius: 8, cursor: "pointer" },
  userEmail: { fontSize: 11, opacity: 0.5 },
  logoutBtn: { background: "none", border: "none", color: "#ff4d4d", fontSize: 11, cursor: "pointer" },
  layout: { flex: 1, display: "grid", gridTemplateColumns: "280px 1fr", overflow: "hidden" },
  sidebar: { borderRight: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", background: "rgba(255,255,255,0.02)" },
  sidebarHeader: { padding: 20, display: "flex", justifyContent: "space-between", alignItems: "center" },
  newChatBtn: { background: "#fff", color: "#000", border: "none", width: 28, height: 28, borderRadius: 8, fontWeight: 800, cursor: "pointer" },
  historyList: { flex: 1, overflowY: "auto", padding: 10 },
  historyItem: { width: "100%", padding: "12px 15px", borderRadius: 12, border: "none", color: "#fff", cursor: "pointer", marginBottom: 8, textAlign: "left", transition: "0.2s" },
  historyTitle: { fontSize: 13, fontWeight: 500, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  historyDate: { fontSize: 10, opacity: 0.4 },
  chatContainer: { display: "flex", flexDirection: "column", height: "100%", position: "relative" },
  messagesThread: { flex: 1, overflowY: "auto", padding: "30px 10%", display: "flex", flexDirection: "column", gap: 20 },
  messageBubble: { maxWidth: "75%", padding: "15px 20px", borderRadius: 20, fontSize: 14, lineHeight: "1.5" },
  roleLabel: { fontSize: 10, fontWeight: 800, marginBottom: 5, textTransform: "uppercase", opacity: 0.7 },
  loadingStatus: { fontSize: 12, opacity: 0.5, fontStyle: "italic", marginLeft: 20 },
  inputArea: { padding: "20px 10%", display: "flex", gap: 15, background: "#05060a" },
  inputField: { flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 15, padding: "15px", color: "#fff", fontSize: 14, resize: "none", height: 50, outline: "none" },
  sendBtn: { background: "#ff8c28", color: "#fff", border: "none", padding: "0 25px", borderRadius: 15, fontWeight: 700, cursor: "pointer" },
  sendBtnDisabled: { background: "#222", color: "#444", border: "none", padding: "0 25px", borderRadius: 15, cursor: "not-allowed" }
};
