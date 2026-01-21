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
  const [error, setError] = useState("");

  const [me, setMe] = useState(null);
  const [agent, setAgent] = useState({ name: "Agent", description: "", avatar_url: "" });

  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const endRef = useRef(null);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function loadMe() {
    const { data } = await supabase.auth.getUser();
    return data?.user || null;
  }

  async function loadAgent() {
    try {
      const { data } = await supabase
        .from("agents")
        .select("name,description,avatar_url")
        .eq("slug", agentSlug)
        .maybeSingle();
      if (data) setAgent(data);
    } catch {}
  }

  async function loadConversations(userId) {
    const { data } = await supabase
      .from("conversations")
      .select("id,title,created_at,archived")
      .eq("user_id", userId)
      .eq("agent_slug", agentSlug)
      .eq("archived", false)
      .order("created_at", { ascending: false });

    setConversations(data || []);
    return data || [];
  }

  async function loadMessages(convId) {
    if (!convId) return setMessages([]);
    const { data } = await supabase
      .from("messages")
      .select("id,role,content,created_at")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });

    setMessages(data || []);
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
          { id: "welcome", role: "assistant", content: getFirstMessage(agentSlug, ""), created_at: new Date().toISOString() },
        ]);
      }
      setLoading(false);
    })();
  }, [agentSlug]);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function startNewConversation() {
    setConversationId(null);
    setMessages([
      { id: "welcome", role: "assistant", content: getFirstMessage(agentSlug, ""), created_at: new Date().toISOString() },
    ]);
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);

    const tempId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: "user", content: text }]);

    try {
      const token = await getAccessToken();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ agentSlug, conversationId, message: text }),
      });

      const data = await res.json();
      setInput("");

      const newConvId = data.conversationId || conversationId;
      if (newConvId !== conversationId) setConversationId(newConvId);
      await loadMessages(newConvId);
      if (me?.id) await loadConversations(me.id);
    } catch {
      setError("Erreur API");
    } finally {
      setSending(false);
    }
  }

  function logout() {
    supabase.auth.signOut();
    window.location.href = "/login";
  }

  if (loading) return <div style={{ padding: 24 }}>Chargement…</div>;

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0b0b0b", color: "#fff" }}>
      <div style={{ width: 280, borderRight: "1px solid #222", padding: 16 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button onClick={() => router.push("/agents")} style={btnSmall}>← Retour</button>
          <button onClick={startNewConversation} style={btnSmall}>+ Nouvelle</button>
        </div>

        <div style={{ fontWeight: 700, marginBottom: 8 }}>Historique</div>

        {conversations.map((c) => (
          <button
            key={c.id}
            onClick={() => {
              setConversationId(c.id);
              loadMessages(c.id);
            }}
            style={{
              width: "100%",
              textAlign: "left",
              padding: 12,
              marginBottom: 8,
              borderRadius: 12,
              border: conversationId === c.id ? "1px solid #b8860b" : "1px solid #222",
              background: "#111",
              color: "#fff",
            }}
          >
            {c.title || "Conversation"}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: 16, borderBottom: "1px solid #222" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
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

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{me?.email}</div>
            <button onClick={logout} style={btnSmall}>Déconnexion</button>
          </div>
        </div>

        <div style={{ flex: 1, padding: 16, overflow: "auto" }}>
          {messages.map((m) => (
            <div key={m.id} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 12 }}>
              <div style={{ maxWidth: "70%", padding: 12, borderRadius: 12, background: m.role === "user" ? "#3a2a00" : "#151515" }}>
                {m.content}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <div style={{ display: "flex", gap: 10, padding: 16, borderTop: "1px solid #222" }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder="Écrire…"
            style={{ flex: 1, padding: 12, borderRadius: 12, background: "#0f0f0f", border: "1px solid #222", color: "#fff" }}
          />
          <button onClick={sendMessage} style={btnPrimary}>Envoyer</button>
        </div>
      </div>
    </div>
  );
}

const btnSmall = {
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid #222",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
};

const btnPrimary = {
  padding: "12px 16px",
  borderRadius: 12,
  border: "1px solid #b8860b",
  background: "#b8860b",
  color: "#000",
  cursor: "pointer",
  fontWeight: 800,
};
