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

  function safeDecode(v) { try { return decodeURIComponent(v || ""); } catch { return v || ""; } }

  function formatTitleFromFirstUserMessage(text) {
    const t = (text || "").trim().replace(/\s+/g, " ");
    if (!t) return "Nouvelle conversation";
    return t.length > 42 ? t.slice(0, 42) + "…" : t;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = threadRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }

  function normalizeImgSrc(src) {
    const s = (src || "").toString().trim();
    if (!s) return "";
    if (s.startsWith("http://") || s.startsWith("https://")) return s;
    if (s.startsWith("/")) return s;
    return "/" + s;
  }

  function getAgentAvatar() {
    if (!agent) return "/images/logopc.png";
    return normalizeImgSrc(agent.avatar_url) || `/images/${agent.slug}.png` || "/images/logopc.png";
  }

  async function fetchAgent(slug) {
    const { data: a, error } = await supabase.from("agents").select("slug, name, description, avatar_url").eq("slug", slug).maybeSingle();
    return error || !a ? null : a;
  }

  async function fetchHistory({ uid, agentSlug }) {
    const { data, error } = await supabase.from("conversations").select("id, title, updated_at").eq("user_id", uid).eq("agent_slug", agentSlug).order("updated_at", { ascending: false }).limit(10);
    return error ? [] : data || [];
  }

  async function fetchMessages({ uid, convId }) {
    const { data, error } = await supabase.from("conversation_messages").select("id, role, content, created_at").eq("user_id", uid).eq("conversation_id", convId).order("created_at", { ascending: true });
    return error ? [] : data || [];
  }

  async function createConversation({ uid, agentSlug, title }) {
    const { data, error } = await supabase.from("conversations").insert({ user_id: uid, agent_slug: agentSlug, title: title || "Nouvelle conversation" }).select("id").single();
    return error ? null : data?.id || null;
  }

  async function touchConversation({ uid, convId, titleMaybe }) {
    const patch = { updated_at: new Date().toISOString() };
    if (titleMaybe) patch.title = titleMaybe;
    await supabase.from("conversations").update(patch).eq("user_id", uid).eq("id", convId);
  }

  async function insertMessage({ uid, convId, role, content }) {
    await supabase.from("conversation_messages").insert({ user_id: uid, conversation_id: convId, role, content });
  }

  useEffect(() => {
    let mounted = true;
    async function boot() {
      setErrorMsg("");
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { window.location.href = "/login"; return; }
      if (!mounted) return;

      const uid = session.user.id;
      setUserId(uid);
      setEmail(session.user.email || "");

      const url = new URL(window.location.href);
      const raw = url.searchParams.get("agent");
      const slug = safeDecode(raw).trim().toLowerCase();

      if (!slug) { window.location.href = "/agents"; return; }

      const a = await fetchAgent(slug);
      if (!a) { window.location.href = "/agents"; return; }
      if (!mounted) return;
      setAgent(a);

      const convParam = url.searchParams.get("c");
      const convIdFromUrl = convParam ? safeDecode(convParam).trim() : "";
      const h = await fetchHistory({ uid, agentSlug: a.slug });
      if (!mounted) return;
      setHistory(h);

      let chosenConvId = null;
      if (convIdFromUrl) {
        const msgs = await fetchMessages({ uid, convId: convIdFromUrl });
        if (msgs.length > 0) {
          chosenConvId = convIdFromUrl;
          setConversationId(chosenConvId);
          setMessages(msgs);
          setLoading(false);
          scrollToBottom();
          return;
        }
      }

      if (h && h.length > 0) {
        chosenConvId = h[0].id;
        setConversationId(chosenConvId);
        const msgs = await fetchMessages({ uid, convId: chosenConvId });
        if (!mounted) return;
        setMessages(msgs.length > 0 ? msgs : [{ role: "assistant", content: `Bonjour, je suis ${a.name}. Comment puis-je vous aider ?` }]);
        setLoading(false);
        scrollToBottom();
        return;
      }

      const newConvId = await createConversation({ uid, agentSlug: a.slug, title: "Nouvelle conversation" });
      if (!mounted) return;
      setConversationId(newConvId);
      setMessages([{ role: "assistant", content: `Bonjour, je suis ${a.name}. Comment puis-je vous aider ?` }]);
      const h2 = await fetchHistory({ uid, agentSlug: a.slug });
      if (mounted) setHistory(h2);
      setLoading(false);
      scrollToBottom();
    }
    boot();
    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => { if (!newSession) window.location.href = "/login"; });
    return () => { mounted = false; data?.subscription?.unsubscribe?.(); };
  }, []);

  async function openConversation(convId) {
    if (!userId || !agent || !convId) return;
    setConversationId(convId);
    const url = new URL(window.location.href);
    url.searchParams.set("agent", agent.slug);
    url.searchParams.set("c", convId);
    window.history.replaceState({}, "", url.toString());
    const msgs = await fetchMessages({ uid: userId, convId });
    setMessages(msgs.length > 0 ? msgs : [{ role: "assistant", content: `Bonjour, je suis ${agent.name}. Comment puis-je vous aider ?` }]);
    scrollToBottom();
  }

  async function newConversation() {
    if (!userId || !agent) return;
    const convId = await createConversation({ uid: userId, agentSlug: agent.slug });
    if (!convId) return;
    setConversationId(convId);
    setMessages([{ role: "assistant", content: `Bonjour, je suis ${agent.name}. Comment puis-je vous aider ?` }]);
    const url = new URL(window.location.href);
    url.searchParams.set("agent", agent.slug);
    url.searchParams.set("c", convId);
    window.history.replaceState({}, "", url.toString());
    const h = await fetchHistory({ uid: userId, agentSlug: agent.slug });
    setHistory(h);
    scrollToBottom();
  }

  async function sendMessage() {
    if (!agent || !conversationId || !canSend) return;
    const userText = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setSending(true);
    scrollToBottom();

    await insertMessage({ uid: userId, convId: conversationId, role: "user", content: userText });

    const isFirstUser = messages.filter((m) => m.role === "user").length === 0;
    const titleMaybe = isFirstUser ? formatTitleFromFirstUserMessage(userText) : null;

    const { data: { session } } = await supabase.auth.getSession();
    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ message: userText, agentSlug: agent.slug, conversationId: conversationId }),
      });
      const data = await resp.json();
      const reply = data.reply || "Désolé, je ne peux pas répondre.";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      await insertMessage({ uid: userId, convId: conversationId, role: "assistant", content: reply });
      await touchConversation({ uid: userId, convId: conversationId, titleMaybe });
      const h = await fetchHistory({ uid: userId, agentSlug: agent.slug });
      setHistory(h);
      scrollToBottom();
    } catch (e) {
      setErrorMsg("Erreur de connexion.");
    } finally {
      setSending(false);
    }
  }

  if (loading || !agent) return null;

  const agentAvatar = getAgentAvatar();

  return (
    <main style={styles.page}>
      <div style={styles.bg} aria-hidden="true"><div style={styles.bgLogo} /><div style={styles.bgVeils} /></div>
      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <button style={styles.backBtn} onClick={() => (window.location.href = "/agents")}>← Retour</button>
          <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.brandLogo} />
          <div style={styles.agentInfo}>
            <div style={styles.agentName}>{agent.name}</div>
            <div style={styles.agentDesc}>{agent.description}</div>
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
            <div style={styles.sidebarTitle}>Historique</div>
            <button onClick={newConversation} style={styles.newBtn}>+ Nouvelle</button>
          </div>
          <div style={styles.sidebarList}>
            {history.map((c) => (
              <button key={c.id} onClick={() => openConversation(c.id)} style={{...styles.histItem, ...(c.id === conversationId ? styles.histItemActive : null)}}>
                <div style={styles.histRow}>
                  <img src={agentAvatar} style={styles.histAvatar} onError={(e) => e.target.src="/images/logopc.png"} />
                  <div style={styles.histTitle}>{c.title || "Conversation"}</div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div style={styles.chatCard}>
          {errorMsg && <div style={styles.alert}>{errorMsg}</div>}
          <div style={styles.thread} ref={threadRef}>
            {messages.map((m, idx) => (
              <div key={idx} style={{...styles.bubbleRow, justifyContent: m.role === "user" ? "flex-end" : "flex-start"}}>
                <div style={{...styles.bubble, ...(m.role === "user" ? styles.bubbleUser : styles.bubbleBot)}}>
                  <div style={styles.bubbleHeader}>
                    {m.role !== "user" && <img src={agentAvatar} style={styles.bubbleAvatar} />}
                    <div style={styles.role}>{m.role === "user" ? "Vous" : agent.name}</div>
                  </div>
                  <div style={styles.text}>{m.content}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={styles.composer}>
            <textarea style={styles.textarea} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendMessage())} placeholder={`Écrire à ${agent.name}...`} rows={2} />
            <button style={canSend ? styles.btn : styles.btnDisabled} onClick={sendMessage} disabled={!canSend}>{sending ? "..." : "Envoyer"}</button>
          </div>
        </div>
      </section>
    </main>
  );
}

const styles = {
  page: { minHeight: "100vh", position: "relative", overflow: "hidden", fontFamily: "Segoe UI, sans-serif", color: "#eef2ff", background: "#05060a" },
  bg: { position: "absolute", inset: 0, zIndex: 0 },
  bgLogo: { position: "absolute", inset: 0, backgroundImage: "url('/images/logopc.png')", backgroundRepeat: "no-repeat", backgroundSize: "contain", backgroundPosition: "center", opacity: 0.08 },
  bgVeils: { position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 50%, rgba(255,140,40,0.1), transparent)" },
  topbar: { position: "relative", zIndex: 2, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(0,0,0,.3)", backdropFilter: "blur(10px)", borderBottom: "1px solid rgba(255,255,255,.1)" },
  topLeft: { display: "flex", alignItems: "center", gap: 12 },
  topRight: { display: "flex", alignItems: "center", gap: 10 },
  backBtn: { padding: "8px 12px", borderRadius: 20, border: "1px solid rgba(255,255,255,.1)", background: "rgba(0,0,0,.3)", color: "#fff", cursor: "pointer" },
  brandLogo: { height: 24 },
  agentInfo: { display: "grid" },
  agentName: { fontWeight: 900, fontSize: 13 },
  agentDesc: { fontSize: 11, opacity: 0.7 },
  userChip: { fontSize: 11, padding: "6px 12px", borderRadius: 20, background: "rgba(0,0,0,.3)", border: "1px solid rgba(255,255,255,.1)" },
  btnGhost: { background: "none", border: "none", color: "#ff4d4d", fontSize: 11, cursor: "pointer" },
  layout: { position: "relative", zIndex: 1, display: "grid", gridTemplateColumns: "280px 1fr", gap: 14, padding: 14, height: "calc(100vh - 64px)" },
  sidebar: { borderRadius: 22, background: "rgba(0,0,0,.4)", backdropFilter: "blur(14px)", display: "flex", flexDirection: "column", overflow: "hidden" },
  sidebarTop: { padding: 15, display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.05)" },
  sidebarTitle: { fontWeight: 900, fontSize: 12 },
  newBtn: { background: "#fff", color: "#000", border: "none", padding: "5px 10px", borderRadius: 8, fontSize: 11, fontWeight: 900, cursor: "pointer" },
  sidebarList: { padding: 10, overflowY: "auto" },
  histItem: { width: "100%", padding: 12, borderRadius: 15, border: "1px solid transparent", background: "none", color: "#fff", cursor: "pointer", textAlign: "left", marginBottom: 5 },
  histItemActive: { background: "rgba(255,140,40,0.1)", border: "1px solid rgba(255,140,40,0.2)" },
  histRow: { display: "flex", alignItems: "center", gap: 10 },
  histAvatar: { width: 24, height: 24, borderRadius: "50%", objectFit: "cover", objectPosition: "center 20%", border: "1px solid rgba(255,255,255,0.1)" },
  histTitle: { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  chatCard: { borderRadius: 22, background: "rgba(0,0,0,.4)", backdropFilter: "blur(14px)", display: "flex", flexDirection: "column", overflow: "hidden" },
  thread: { flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 15 },
  bubbleRow: { display: "flex" },
  bubble: { maxWidth: "80%", padding: "12px 16px", borderRadius: 18, border: "1px solid rgba(255,255,255,0.05)" },
  bubbleUser: { background: "rgba(255,255,255,0.05)" },
  bubbleBot: { background: "rgba(0,0,0,0.3)" },
  bubbleHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 5 },
  bubbleAvatar: { width: 20, height: 20, borderRadius: "50%", objectFit: "cover", objectPosition: "center 20%" },
  role: { fontSize: 10, fontWeight: 900, opacity: 0.5 },
  text: { fontSize: 14, lineHeight: 1.5 },
  composer: { padding: 15, display: "flex", gap: 10, background: "rgba(0,0,0,0.2)" },
  textarea: { flex: 1, background: "#000", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 12, color: "#fff", resize: "none" },
  btn: { background: "#ff8c28", color: "#fff", border: "none", borderRadius: 12, padding: "0 20px", fontWeight: 900, cursor: "pointer" },
  btnDisabled: { background: "#222", color: "#555", borderRadius: 12, padding: "0 20px" },
  alert: { background: "rgba(255,0,0,0.1)", padding: 10, color: "#ff4d4d", fontSize: 12, textAlign: "center" }
};
