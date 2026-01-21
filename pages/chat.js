// pages/chat.js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import { getFirstMessage } from "../lib/agentPrompts";

export default function ChatPage() {
  const router = useRouter();
  const agentSlug = useMemo(() => {
    const q = router.query?.agent;
    return (typeof q === "string" && q) ? q : "emma";
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
    // Optionnel: table 'agents' (sinon fallback)
    try {
      const { data, error } = await supabase
        .from("agents")
        .select("name,description,avatar_url")
        .eq("slug", agentSlug)
        .maybeSingle();
      if (!error && data) {
        setAgent({
          name: data.name || agentSlug,
          description: data.description || "",
          avatar_url: data.avatar_url || "",
        });
      } else {
        setAgent({ name: agentSlug, description: "", avatar_url: "" });
      }
    } catch {
      setAgent({ name: agentSlug, description: "", avatar_url: "" });
    }
  }

  async function loadConversations(userId) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id,title,created_at,archived")
      .eq("user_id", userId)
      .eq("agent_slug", agentSlug)
      .eq("archived", false)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    setConversations(data || []);
    return data || [];
  }

  async function loadMessages(convId) {
    if (!convId) {
      setMessages([]);
      return;
    }
    const { data, error } = await supabase
      .from("messages")
      .select("id,role,content,created_at")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) throw error;
    setMessages(data || []);
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");

      const user = await loadMe();
      if (!user) {
        window.location.href = "/login";
        return;
      }
      setMe(user);

      await loadAgent();

      try {
        const convs = await loadConversations(user.id);
        const firstId = convs?.[0]?.id || null;
        setConversationId(firstId);
        await loadMessages(firstId);

        // Si aucune conversation, on montre un message d'accueil local (pas en DB)
        if (!firstId) {
          setMessages([
            { id: "local-welcome", role: "assistant", content: getFirstMessage(agentSlug, ""), created_at: new Date().toISOString() },
          ]);
        }
      } catch (e) {
        console.error(e);
        setError("Erreur lors du chargement.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSlug]);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function startNewConversation() {
    // Juste reset local: la conversation sera créée au 1er envoi via /api/chat
    setConversationId(null);
    setMessages([
      { id: "local-welcome", role: "assistant", content: getFirstMessage(agentSlug, ""), created_at: new Date().toISOString() },
    ]);
  }

  async function sendMessage() {
    setError("");
    const text = input;
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setSending(true);

    // Optimistic UI
    const tempId = `tmp-${Date.now()}`;
    setMessages((prev) => [...prev, { id: tempId, role: "user", content: trimmed, created_at: new Date().toISOString() }]);

    try {
      const token = await getAccessToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agentSlug,
          conversationId,
          message: trimmed,
        }),
      });

      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = data?.message || data?.error || "Erreur interne API";
        throw new Error(msg);
      }

      // Clear only on success
      setInput("");

      // Conversation peut etre creee cote serveur
      const newConvId = data?.conversationId || conversationId;
      if (newConvId && newConvId !== conversationId) {
        setConversationId(newConvId);
      }

      // Reload DB state (source of truth)
      if (me?.id) await loadConversations(me.id);
      await loadMessages(newConvId);
    } catch (e) {
      console.error(e);
      setError(e?.message || "Erreur interne API");
      // Restore input so the user doesn't lose it
      setInput(text);
      // Remove optimistic message
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    } finally {
      setSending(false);
    }
  }

  function logout() {
    supabase.auth.signOut();
    window.location.href = "/login";
  }

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui" }}>
        Chargement...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0b0b0b", color: "#fff" }}>
      {/* Sidebar */}
      <div style={{ width: 280, borderRight: "1px solid #222", padding: 16, boxSizing: "border-box" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button onClick={() => router.push("/agents")} style={btnSmall}>
            ← Retour aux agents
          </button>
          <button onClick={startNewConversation} style={btnSmall}>
            + Nouvelle
          </button>
        </div>

        <div style={{ fontWeight: 700, marginBottom: 8 }}>Historique</div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, overflow: "auto", maxHeight: "calc(100vh - 120px)" }}>
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={async () => {
                setConversationId(c.id);
                await loadMessages(c.id);
              }}
              style={{
                textAlign: "left",
                padding: 12,
                borderRadius: 12,
                border: conversationId === c.id ? "1px solid #b8860b" : "1px solid #222",
                background: "#111",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 600 }}>{c.title || "(sans titre)"}</div>
              <div style={{ opacity: 0.6, fontSize: 12 }}>{new Date(c.created_at).toLocaleString()}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottom: "1px solid #222" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                background: "#222",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {agent.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={agent.avatar_url} alt={agent.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <span style={{ fontWeight: 700 }}>{agent.name?.[0]?.toUpperCase() || "A"}</span>
              )}
            </div>
            <div>
              <div style={{ fontWeight: 800 }}>{agent.name}</div>
              <div style={{ opacity: 0.7, fontSize: 12 }}>{agent.description}</div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ opacity: 0.7, fontSize: 12 }}>{me?.email}</div>
            <button onClick={logout} style={btnSmall}>Déconnexion</button>
          </div>
        </div>

        <div style={{ flex: 1, padding: 16, overflow: "auto" }}>
          {messages.map((m) => (
            <div key={m.id} style={{ marginBottom: 12, display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              <div
                style={{
                  maxWidth: "70%",
                  padding: "10px 12px",
                  borderRadius: 12,
                  background: m.role === "user" ? "#3a2a00" : "#151515",
                  border: "1px solid #222",
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.content}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {error ? (
          <div style={{ padding: 12, borderTop: "1px solid #222", background: "#2a0000", color: "#ffd0d0" }}>{error}</div>
        ) : null}

        <div style={{ padding: 16, borderTop: "1px solid #222", display: "flex", gap: 10 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Écrire..."
            style={{
              flex: 1,
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid #222",
              background: "#0f0f0f",
              color: "#fff",
              outline: "none",
            }}
            disabled={sending}
          />
          <button onClick={sendMessage} style={{ ...btnPrimary, opacity: sending ? 0.7 : 1 }} disabled={sending}>
            Envoyer
          </button>
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
