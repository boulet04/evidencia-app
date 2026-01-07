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

  // Fonctions de chargement
  async function loadMessages(convId) {
    const { data } = await supabase.from("messages").select("*").eq("conversation_id", convId).order("created_at", { ascending: true });
    return data || [];
  }

  async function loadHistory(uid, slug) {
    const { data } = await supabase.from("conversations").select("*").eq("user_id", uid).eq("agent_slug", slug).order("updated_at", { ascending: false });
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

      const { data: ag } = await supabase.from("agents").select("*").eq("slug", slug).single();
      if (!ag) { window.location.href = "/agents"; return; }
      setAgent(ag);

      const h = await loadHistory(uid, slug);
      setHistory(h);

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

  // LOGIQUE D'ENVOI RESTAURÉE
  async function sendMessage() {
    if (!canSend || !conversationId) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    // 1. Affichage immédiat
    const updatedMessages = [...messages, { role: "user", content: text }];
    setMessages(updatedMessages);
    scrollToBottom();

    try {
      const { data: { session } } = await supabase.auth.getSession();
      
      // 2. Appel API (La méthode qui marchait)
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json", 
          Authorization: `Bearer ${session?.access_token}` 
        },
        body: JSON.stringify({ 
          message: text, 
          agentSlug: agent.slug,
          conversationId: conversationId // On passe l'ID pour que l'API enregistre au bon endroit
        })
      });
      
      const json = await res.json();
      if (json.reply) {
        setMessages([...updatedMessages, { role: "assistant", content: json.reply }]);
        // On rafraîchit l'historique car l'API a normalement mis à jour le titre
        const h = await loadHistory(userId, agent.slug);
        setHistory(h);
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
      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <button onClick={() => window.location.href="/agents"} style={styles.backBtn}>← Retour</button>
          <img src="/images/logolong.png" alt="logo" style={{ height: 25 }} />
          
          {/* L'AVATAR (Ta demande) */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: 15 }}>
            <img 
              src={`/images/${agent.slug}.png`} 
              style={{ width: 42, height: 42, borderRadius: "50%", border: "2px solid #ff8c28", objectFit: "cover", objectPosition: "center 20%" }} 
            />
            <div>
              <div style={{ fontWeight: 800, fontSize: 13 }}>{agent.name}</div>
              <div style={{ fontSize: 10, opacity: 0.6 }}>Agent disponible</div>
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
            <span style={{ fontWeight: 800 }}>Historique</span>
            <button onClick={() => window.location.href=`/chat?agent=${agent.slug}`} style={styles.newBtn}>+ Nouvelle</button>
          </div>
          <div style={styles.sidebarList}>
            {history.map(c => (
              <button key={c.id} onClick={() => window.location.href=`/chat?agent=${agent.slug}&c=${c.id}`} style={{
                ...styles.histItem,
                background: c.id === conversationId ? "rgba(255,140,40,0.1)" : "transparent"
              }}>
                {c.title || "Conversation"}
              </button>
            ))}
          </div>
        </aside>

        <div style={styles.chatCard}>
          <div style={styles.thread} ref={threadRef}>
            {messages.map((m, i) => (
              <div key={i} style={{ ...styles.bubble, alignSelf: m.role === "user" ? "flex-end" : "flex-start", background: m.role === "user" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.3)" }}>
                <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 4 }}>{m.role === "user" ? "VOUS" : agent.name}</div>
                <div>{m.content}</div>
              </div>
            ))}
          </div>
          <div style={styles.composer}>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if(e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }} style={styles.textarea} placeholder="Écrivez ici..." />
            <button disabled={!canSend} onClick={sendMessage} style={canSend ? styles.sendBtn : styles.sendBtnDisabled}>{sending ? "..." : "Envoyer"}</button>
          </div>
        </div>
      </section>
    </main>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#05060a", color: "#fff", fontFamily: "sans-serif" },
  topbar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px", background: "rgba(0,0,0,0.5)", borderBottom: "1px solid rgba(255,255,255,0.1)" },
  topLeft: { display: "flex", alignItems: "center", gap: 15 },
  topRight: { display: "flex", alignItems: "center", gap: 15 },
  backBtn: { background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", padding: "5px 12px", borderRadius: 15, cursor: "pointer" },
  userChip: { fontSize: 11, opacity: 0.6 },
  btnGhost: { background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", padding: "5px 12px", borderRadius: 15, cursor: "pointer" },
  layout: { display: "grid", gridTemplateColumns: "250px 1fr", gap: 20, padding: 20, height: "calc(100vh - 70px)" },
  sidebar: { background: "rgba(0,0,0,0.2)", borderRadius: 15, border: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column" },
  sidebarTop: { padding: 15, display: "flex", justifyContent: "space-between", alignItems: "center" },
  newBtn: { background: "#fff", color: "#000", border: "none", padding: "5px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer" },
  sidebarList: { flex: 1, overflowY: "auto", padding: 10 },
  histItem: { width: "100%", textAlign: "left", padding: "10px", borderRadius: 10, border: "none", color: "#fff", cursor: "pointer", marginBottom: 5, fontSize: 12 },
  chatCard: { background: "rgba(0,0,0,0.2)", borderRadius: 20, border: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", overflow: "hidden" },
  thread: { flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 15 },
  bubble: { maxWidth: "80%", padding: "12px 15px", borderRadius: 15, fontSize: 14 },
  composer: { padding: 15, display: "flex", gap: 10, background: "rgba(0,0,0,0.2)" },
  textarea: { flex: 1, background: "rgba(255,255,255,0.05)", border: "none", borderRadius: 10, padding: 10, color: "#fff", resize: "none" },
  sendBtn: { background: "#ff8c28", border: "none", color: "#fff", padding: "0 20px", borderRadius: 10, fontWeight: 700, cursor: "pointer" },
  sendBtnDisabled: { background: "#333", color: "#666", borderRadius: 10, padding: "0 20px", cursor: "not-allowed" }
};
