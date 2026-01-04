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

  const isMobile =
    typeof window !== "undefined" && window.innerWidth <= 768;

  const [mobileView, setMobileView] = useState("chat"); // "list" | "chat"

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

  async function fetchAgent(slug) {
    const { data } = await supabase
      .from("agents")
      .select("slug, name, description")
      .eq("slug", slug)
      .maybeSingle();

    return data || null;
  }

  async function fetchHistory(uid, slug) {
    const { data } = await supabase
      .from("conversations")
      .select("id, title, updated_at")
      .eq("user_id", uid)
      .eq("agent_slug", slug)
      .order("updated_at", { ascending: false });

    return data || [];
  }

  async function fetchMessages(uid, convId) {
    const { data } = await supabase
      .from("conversation_messages")
      .select("role, content")
      .eq("user_id", uid)
      .eq("conversation_id", convId)
      .order("created_at");

    return data || [];
  }

  async function createConversation(uid, slug) {
    const { data } = await supabase
      .from("conversations")
      .insert({
        user_id: uid,
        agent_slug: slug,
        title: "Nouvelle conversation",
      })
      .select("id")
      .single();

    return data?.id || null;
  }

  useEffect(() => {
    let mounted = true;

    async function boot() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        window.location.href = "/login";
        return;
      }

      if (!mounted) return;

      setEmail(session.user.email || "");
      setUserId(session.user.id);

      const url = new URL(window.location.href);
      const slug = (url.searchParams.get("agent") || "").toLowerCase();

      if (!slug) {
        window.location.href = "/agents";
        return;
      }

      const a = await fetchAgent(slug);
      if (!a) {
        alert("Agent introuvable");
        window.location.href = "/agents";
        return;
      }

      setAgent(a);

      const hist = await fetchHistory(session.user.id, slug);
      setHistory(hist);

      let convId = hist[0]?.id;

      if (!convId) {
        convId = await createConversation(session.user.id, slug);
      }

      setConversationId(convId);

      const msgs = await fetchMessages(session.user.id, convId);

      setMessages(
        msgs.length
          ? msgs
          : [
              {
                role: "assistant",
                content: `Bonjour, je suis ${a.name}. Comment puis-je vous aider ?`,
              },
            ]
      );

      setLoading(false);
      scrollToBottom();

      if (isMobile) {
        setMobileView("list");
      }
    }

    boot();

    return () => {
      mounted = false;
    };
  }, []);

  async function sendMessage() {
    if (!canSend || !conversationId) return;

    const text = input.trim();
    setInput("");
    setSending(true);

    setMessages((m) => [...m, { role: "user", content: text }]);
    scrollToBottom();

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

      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.reply || "Erreur." },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "Erreur interne." },
      ]);
    }

    setSending(false);
    scrollToBottom();
  }

  if (loading || !agent) return null;

  return (
    <main style={styles.page}>
      <header style={styles.topbar}>
        <button
          style={styles.back}
          onClick={() =>
            isMobile ? setMobileView("list") : (window.location.href = "/agents")
          }
        >
          ← Retour
        </button>

        <div style={styles.center}>
          <strong>{agent.name}</strong>
        </div>

        <button
          style={styles.logout}
          onClick={() => supabase.auth.signOut().then(() => (window.location.href = "/login"))}
        >
          Déconnexion
        </button>
      </header>

      <section style={styles.layout}>
        {(!isMobile || mobileView === "list") && (
          <aside style={styles.sidebar}>
            {history.map((c) => (
              <button
                key={c.id}
                style={styles.histItem}
                onClick={() => {
                  setConversationId(c.id);
                  if (isMobile) setMobileView("chat");
                }}
              >
                {c.title || "Conversation"}
              </button>
            ))}
          </aside>
        )}

        {(!isMobile || mobileView === "chat") && (
          <div style={styles.chat}>
            <div ref={threadRef} style={styles.thread}>
              {messages.map((m, i) => (
                <div key={i} style={styles.bubble}>
                  <strong>{m.role === "user" ? "Vous" : agent.name}</strong>
                  <div>{m.content}</div>
                </div>
              ))}
            </div>

            <div style={styles.composer}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
              />
              <button disabled={!canSend} onClick={sendMessage}>
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
  page: { minHeight: "100vh", background: "#05060a", color: "#fff" },
  topbar: { display: "flex", justifyContent: "space-between", padding: 12 },
  back: { background: "none", color: "#fff", border: "none" },
  logout: { background: "none", color: "#fff", border: "none" },
  layout: { display: "flex", height: "calc(100vh - 60px)" },
  sidebar: { width: 260, padding: 12 },
  histItem: { width: "100%", marginBottom: 8 },
  chat: { flex: 1, display: "flex", flexDirection: "column" },
  thread: { flex: 1, overflowY: "auto", padding: 12 },
  bubble: { marginBottom: 10 },
  composer: { display: "flex", padding: 12, gap: 8 },
};
