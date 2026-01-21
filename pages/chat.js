// pages/chat.js
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";

export default function ChatPage() {
  const router = useRouter();
  const agentSlug = typeof router.query.agent === "string" ? router.query.agent : null;

  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  async function getToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  }

  async function loadAgent() {
    const { data } = await supabase
      .from("agents")
      .select("id, name, slug, avatar_url")
      .eq("slug", agentSlug)
      .maybeSingle();

    setAgent(data || null);
  }

  async function loadConversations() {
    const token = await getToken();
    if (!token) return;

    const res = await fetch("/api/conversations/list", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();

    const list = (json.conversations || []).filter(
      (c) => c.agent_slug === agentSlug
    );

    setConversations(list);
    if (!conversationId && list[0]) {
      setConversationId(list[0].id);
    }
  }

  async function loadMessages(cid) {
    if (!cid) {
      setMessages([]);
      return;
    }

    const token = await getToken();
    if (!token) return;

    const res = await fetch(`/api/conversations/${cid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    setMessages(json.messages || []);
  }

  async function createConversation() {
    const token = await getToken();
    if (!token) return;

    const res = await fetch("/api/conversations/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agentSlug }),
    });

    const json = await res.json();
    if (json?.id) {
      setConversationId(json.id);
      await loadConversations();
    }
  }

  async function sendMessage() {
    if (!input.trim() || sending) return;
    setSending(true);

    const token = await getToken();
    if (!token) return;

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        agentSlug,
        conversationId,
        message: input,
      }),
    });

    const json = await res.json();
    setInput("");
    setSending(false);

    if (json?.conversationId && json.conversationId !== conversationId) {
      setConversationId(json.conversationId);
      await loadConversations();
    }

    await loadMessages(json.conversationId || conversationId);
  }

  useEffect(() => {
    if (!agentSlug) return;
    (async () => {
      setLoading(true);
      await loadAgent();
      await loadConversations();
      setLoading(false);
    })();
  }, [agentSlug]);

  useEffect(() => {
    loadMessages(conversationId);
  }, [conversationId]);

  if (loading || !agent) {
    return <div style={{ padding: 20 }}>Chargement…</div>;
  }

  return (
    <div style={styles.page}>
      {/* SIDEBAR */}
      <aside style={styles.sidebar}>
        <button style={styles.newConvBtn} onClick={createConversation}>
          + Nouvelle conversation
        </button>

        <div style={styles.convList}>
          {conversations.map((c) => (
            <div
              key={c.id}
              onClick={() => setConversationId(c.id)}
              style={{
                ...styles.convItem,
                ...(c.id === conversationId ? styles.convActive : {}),
              }}
            >
              {c.title || "Conversation"}
            </div>
          ))}
        </div>
      </aside>

      {/* MAIN */}
      <main style={styles.main}>
        {/* HEADER FIXE */}
        <header style={styles.header}>
          <button onClick={() => router.push("/agents")} style={styles.backBtn}>
            ← Agents
          </button>

          <div style={styles.agentInfo}>
            {agent.avatar_url && (
              <img src={agent.avatar_url} style={styles.avatar} />
            )}
            <span>{agent.name}</span>
          </div>
        </header>

        {/* MESSAGES */}
        <div style={styles.messages}>
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                ...styles.msg,
                ...(m.role === "user" ? styles.userMsg : styles.aiMsg),
              }}
            >
              {m.content}
            </div>
          ))}
        </div>

        {/* INPUT */}
        <div style={styles.inputBar}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Votre message…"
            style={styles.input}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          />
          <button onClick={sendMessage} disabled={sending}>
            Envoyer
          </button>
        </div>
      </main>
    </div>
  );
}

const styles = {
  page: {
    display: "flex",
    height: "100vh",
    background: "#050608",
    color: "#e9eef6",
  },
  sidebar: {
    width: 280,
    borderRight: "1px solid rgba(255,255,255,0.08)",
    padding: 12,
    overflowY: "auto",
  },
  newConvBtn: {
    width: "100%",
    marginBottom: 12,
  },
  convList: {},
  convItem: {
    padding: 10,
    cursor: "pointer",
    borderRadius: 6,
    opacity: 0.8,
  },
  convActive: {
    background: "rgba(255,255,255,0.08)",
    opacity: 1,
  },
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
  },
  header: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 16px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    background: "#050608",
  },
  backBtn: {},
  agentInfo: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    objectFit: "cover",
  },
  messages: {
    flex: 1,
    padding: 16,
    overflowY: "auto",
  },
  msg: {
    maxWidth: "70%",
    marginBottom: 12,
    padding: 10,
    borderRadius: 8,
  },
  userMsg: {
    alignSelf: "flex-end",
    background: "#2563eb",
  },
  aiMsg: {
    alignSelf: "flex-start",
    background: "rgba(255,255,255,0.08)",
  },
  inputBar: {
    display: "flex",
    gap: 8,
    padding: 12,
    borderTop: "1px solid rgba(255,255,255,0.08)",
  },
  input: {
    flex: 1,
  },
};
