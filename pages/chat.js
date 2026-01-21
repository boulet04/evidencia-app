// pages/chat.js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import { getFirstMessage } from "../lib/agentPrompts";

export default function ChatPage() {
  const router = useRouter();
  const agentSlug = useMemo(() => {
    const q = router.query?.agent;
    return typeof q === "string" && q ? q : "emma";
  }, [router.query]);

  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const [me, setMe] = useState(null);
  const [agent, setAgent] = useState({ name: "Agent", description: "", avatar_url: "" });

  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const endRef = useRef(null);

  async function loadMe() {
    const { data } = await supabase.auth.getUser();
    return data?.user || null;
  }

  async function loadAgent() {
    const { data } = await supabase
      .from("agents")
      .select("name,description,avatar_url")
      .eq("slug", agentSlug)
      .maybeSingle();
    if (data) setAgent(data);
  }

  async function loadConversations(userId) {
    const { data } = await supabase
      .from("conversations")
      .select("id,title,created_at")
      .eq("user_id", userId)
      .eq("agent_slug", agentSlug)
      .order("created_at", { ascending: false });

    setConversations(data || []);
    return data || [];
  }

  async function loadMessages(convId) {
    if (!convId) return setMessages([]);
    const { data } = await supabase
      .from("messages")
      .select("id,role,content")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });
    setMessages(data || []);
  }

  async function deleteConversation(id) {
    await supabase.from("conversations").delete().eq("id", id);

    if (id === conversationId) {
      setConversationId(null);
      setMessages([
        { id: "welcome", role: "assistant", content: getFirstMessage(agentSlug, "") },
      ]);
    }

    if (me?.id) await loadConversations(me.id);
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      const user = await loadMe();
      if (!user) return (window.location.href = "/login");
      setMe(user);
      await loadAgent();
      const convs = await loadConversations(user.id);
      const firstId = convs?.[0]?.id || null;
      setConversationId(firstId);
      await loadMessages(firstId);
      if (!firstId) {
        setMessages([
          { id: "welcome", role: "assistant", content: getFirstMessage(agentSlug, "") },
        ]);
      }
      setLoading(false);
    })();
  }, [agentSlug]);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);

    const tempId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: "user", content: text }]);

    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ agentSlug, conversationId, message: text }),
    });

    const data = await res.json();
    setInput("");
    setConversationId(data.conversationId);
    await loadMessages(data.conversationId);
    if (me?.id) await loadConversations(me.id);

    setSending(false);
  }

  if (loading) return <div style={{ padding: 24 }}>Chargement…</div>;

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0b0b0b", color: "#fff" }}>
      {/* SIDEBAR */}
      <div style={{ width: 280, borderRight: "1px solid #222", padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Historique</div>

        {conversations.map((c) => (
          <div
            key={c.id}
            onClick={() => {
              setConversationId(c.id);
              loadMessages(c.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: 10,
              marginBottom: 6,
              borderRadius: 10,
              background: conversationId === c.id ? "#1a1a1a" : "#111",
              border: conversationId === c.id ? "1px solid #b8860b" : "1px solid #222",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              {c.title || "Conversation"}
            </div>

            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteConversation(c.id);
              }}
              title="Supprimer"
              style={{
                background: "transparent",
                border: "none",
                color: "#ff4d4f",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* MAIN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {/* HEADER AGENT — RESTAURÉ */}
        <div style={{ display: "flex", justifyContent: "space-between", padding: 16, borderBottom: "1px solid #222" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={() => router.push("/agents")}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid #222",
                background: "#111",
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              ← Retour
            </button>

            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                background: "#222",
                overflow: "hidden",
              }}
            >
              {agent.avatar_url && (
                <img
                  src={agent.avatar_url}
                  alt={agent.name}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    objectPosition: "center top",
                  }}
                />
              )}
            </div>

            <div>
              <div style={{ fontWeight: 800 }}>{agent.name}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{agent.description}</div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{me.email}</div>
            <button
              onClick={() => {
                supabase.auth.signOut();
                window.location.href = "/login";
              }}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid #222",
                background: "#111",
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Déconnexion
            </button>
          </div>
        </div>

        {/* MESSAGES */}
        <div style={{ flex: 1, padding: 16, overflow: "auto" }}>
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                display: "flex",
                justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  maxWidth: "70%",
                  padding: 12,
                  borderRadius: 12,
                  background: m.role === "user" ? "#3a2a00" : "#151515",
                }}
              >
                {m.content}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {/* INPUT */}
        <div style={{ display: "flex", gap: 10, padding: 16, borderTop: "1px solid #222" }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder="Écrire…"
            style={{
              flex: 1,
              padding: 12,
              borderRadius: 12,
              background: "#0f0f0f",
              border: "1px solid #222",
              color: "#fff",
            }}
          />
          <button
            onClick={sendMessage}
            style={{
              padding: "12px 16px",
              borderRadius: 12,
              border: "1px solid #b8860b",
              background: "#b8860b",
              color: "#000",
              cursor: "pointer",
              fontWeight: 800,
            }}
          >
            Envoyer
          </button>
        </div>
      </div>
    </div>
  );
}
