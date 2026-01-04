// pages/chat.js
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
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  const [mobileView, setMobileView] = useState("history");

  const canSend = useMemo(
    () => input.trim().length > 0 && !sending,
    [input, sending]
  );

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (threadRef.current) {
        threadRef.current.scrollTop = threadRef.current.scrollHeight;
      }
    });
  }

  useEffect(() => {
    let mounted = true;

    async function boot() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = "/login";
        return;
      }

      const uid = session.user.id;
      setUserId(uid);
      setEmail(session.user.email || "");

      const url = new URL(window.location.href);
      const slug = (url.searchParams.get("agent") || "").toLowerCase();

      const { data: a } = await supabase
        .from("agents")
        .select("slug, name, description, avatar_url")
        .eq("slug", slug)
        .maybeSingle();

      if (!a) {
        window.location.href = "/agents";
        return;
      }

      setAgent(a);

      const { data: h } = await supabase
        .from("conversations")
        .select("id, title, updated_at")
        .eq("user_id", uid)
        .eq("agent_slug", a.slug)
        .order("updated_at", { ascending: false });

      setHistory(h || []);

      if (h && h.length > 0) {
        const convId = h[0].id;
        setConversationId(convId);

        const { data: msgs } = await supabase
          .from("conversation_messages")
          .select("role, content")
          .eq("conversation_id", convId)
          .order("created_at", { ascending: true });

        setMessages(msgs || []);
      } else {
        setMessages([
          {
            role: "assistant",
            content: `Bonjour, je suis ${a.name}. Comment puis-je vous aider ?`,
          },
        ]);
      }

      setLoading(false);
      scrollToBottom();
    }

    boot();
    return () => { mounted = false; };
  }, []);

  async function sendMessage() {
    if (!canSend) return;
    const text = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          agentSlug: agent.slug,
        }),
      });

      const data = await res.json();
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "Erreur interne. Réessayez plus tard." },
      ]);
    } finally {
      setSending(false);
      scrollToBottom();
    }
  }

  if (loading || !agent) return null;

  return (
    <main style={styles.page}>
      <header style={styles.topbar}>
        <button
          style={styles.backBtn}
          onClick={() =>
            isMobile
              ? setMobileView("history")
              : (window.location.href = "/agents")
          }
        >
          ← Retour
        </button>

        <img src="/images/logolong.png" style={styles.brandLogo} />
      </header>

      <section style={styles.layout}>
        {(!isMobile || mobileView === "history") && (
          <aside style={styles.sidebar}>
            <h3 style={{ color: "#fff" }}>Historique</h3>
            {history.map((c) => (
              <button
                key={c.id}
                style={styles.histItem}
                onClick={() => {
                  setConversationId(c.id);
                  if (isMobile) setMobileView("chat");
();
                }}
              >
                {c.title}
              </button>
            ))}
          </aside>
        )}

        {(!isMobile || mobileView === "chat") && (
          <div style={styles.chatCard}>
            {isMobile && (
              <button
                style={styles.mobileSwitch}
                onClick={() => setMobileView("history")}
              >
                ← Historique
              </button>
            )}

            <div style={styles.thread} ref={threadRef}>
              {messages.map((m, i) => (
                <div
                  key={i}
                  style={{
                    ...styles.bubble,
                    alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  {m.content}
                </div>
              ))}
            </div>

            <div style={styles.composer}>
              <textarea
                style={styles.textarea}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Votre message…"
              />
              <button style={styles.btn} onClick={sendMessage}>
                Envoyer
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#000", color: "#fff" },
  topbar: { padding: 12, display: "flex", gap: 12 },
  backBtn: { background: "none", color: "#fff", border: "none" },
  brandLogo: { height: 24 },
  layout: { display: "grid", gridTemplateColumns: "1fr 3fr", height: "calc(100vh - 60px)" },
  sidebar: { padding: 12, borderRight: "1px solid #333" },
  histItem: { display: "block", width: "100%", marginBottom: 8 },
  chatCard: { display: "flex", flexDirection: "column", height: "100%" },
  thread: { flex: 1, overflowY: "auto", padding: 12 },
  bubble: { padding: 12, background: "#222", borderRadius: 12, marginBottom: 8 },
  composer: { display: "flex", gap: 8, padding: 12 },
  textarea: { flex: 1 },
  btn: { padding: "0 16px" },
  mobileSwitch: {
    padding: 10,
    background: "#111",
    color: "#fff",
    border: "1px solid #333",
    marginBottom: 8,
  },
};
