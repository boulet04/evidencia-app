import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import { getFirstMessage } from "../lib/agentPrompts";

/* ===== RENOMMAGE AUTO — INCHANGÉ ===== */
function buildConversationTitle(text) {
  const stop = new Set(["salut", "bonjour", "hello", "coucou", "hey"]);

  const words = text
    .toLowerCase()
    .replace(/[^a-zàâäéèêëïîôöùûüç0-9\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);

  while (words.length && stop.has(words[0])) {
    words.shift();
  }

  return words.slice(0, 6).join(" ");
}
/* =================================== */

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

  // ÉTAT POUR LE MENU MOBILE
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const endRef = useRef(null);
  const inputRef = useRef(null); 

  // 🎤 MICRO — inchangé
  const recognitionRef = useRef(null);
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.lang = "fr-FR";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);

    recognition.onresult = (e) => {
      const text = e.results[0][0].transcript;
      setInput((prev) => (prev ? prev + " " + text : text));
    };

    recognitionRef.current = recognition;
  }, []);

  function toggleMic() {
    if (!recognitionRef.current) return;
    listening
      ? recognitionRef.current.stop()
      : recognitionRef.current.start();
  }

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

  async function startNewConversation() {
    setConversationId(null);
    setMessages([
      { id: "welcome", role: "assistant", content: getFirstMessage(agentSlug, "") },
    ]);
    setIsSidebarOpen(false); // Ferme la sidebar sur mobile après création
  }

  async function deleteConversation(id) {
    await supabase.from("conversations").delete().eq("id", id);
    if (id === conversationId) {
      startNewConversation();
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
      if (!firstId) startNewConversation();
      setLoading(false);
    })();
  }, [agentSlug]);

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  useEffect(() => {
    if (loading) return;
    const t = setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [agentSlug, conversationId, sending]);

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

    if (!conversationId && data.conversationId) {
      const title = buildConversationTitle(text);
      if (title) {
        await supabase
          .from("conversations")
          .update({ title })
          .eq("id", data.conversationId);
      }
    }

    setConversationId(data.conversationId);
    await loadMessages(data.conversationId);
    if (me?.id) await loadConversations(me.id);

    setSending(false);
  }

  if (loading) return <div style={{ padding: 24, background: "#0b0b0b", color: "#fff", height: "100vh" }}>Chargement…</div>;

  return (
    <div className="layout-container">
      
      {/* HEADER MOBILE UNIQUEMENT */}
      <div className="mobile-header">
        <button onClick={() => setIsSidebarOpen(true)} className="menu-trigger">☰</button>
        <div className="mobile-agent-info">
            <span style={{fontWeight: 800, fontSize: 14}}>{agent.name}</span>
        </div>
        <button onClick={() => router.push("/agents")} className="menu-trigger">←</button>
      </div>

      {/* SIDEBAR */}
      <div className={`sidebar ${isSidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
            <div style={{ fontWeight: 700 }}>Historique</div>
            <button className="mobile-only close-btn" onClick={() => setIsSidebarOpen(false)}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button onClick={startNewConversation} style={btnSmall}>
            + Nouvelle
          </button>
        </div>

        <div className="conv-list">
            {conversations.map((c) => (
            <div
                key={c.id}
                onClick={() => {
                setConversationId(c.id);
                loadMessages(c.id);
                setIsSidebarOpen(false); // Ferme après sélection sur mobile
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
      </div>

      {/* MAIN */}
      <div className="main-content">
        {/* HEADER AGENT (Caché ou adapté sur mobile) */}
        <div className="desktop-header">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => router.push("/agents")} style={btnSmall}>
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
              style={btnSmall}
            >
              Déconnexion
            </button>
          </div>
        </div>

        {/* MESSAGES */}
        <div className="messages-container">
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
                className="message-bubble"
                style={{
                  maxWidth: "75%",
                  padding: 12,
                  borderRadius: 12,
                  background: m.role === "user" ? "#3a2a00" : "#151515",
                  fontSize: "14px",
                  lineHeight: "1.4"
                }}
              >
                {m.content}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {/* INPUT */}
        <div className="input-container">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder="Écrire…"
            className="chat-input"
          />

          <button
            type="button"
            onClick={toggleMic}
            className="mic-btn"
            style={{ background: listening ? "#8b0000" : "#111" }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3z" />
              <path d="M19 11a7 7 0 01-14 0h2a5 5 0 0010 0h2z" />
              <path d="M12 18v4h-2v-4h2z" />
            </svg>
          </button>

          <button onClick={sendMessage} className="send-btn">
            Envoyer
          </button>
        </div>
      </div>

      <style jsx>{`
        .layout-container {
          display: flex;
          height: 100vh;
          background: #0b0b0b;
          color: #fff;
          overflow: hidden;
        }

        .sidebar {
          width: 280px;
          border-right: 1px solid #222;
          padding: 16px;
          background: #0b0b0b;
          display: flex;
          flex-direction: column;
          z-index: 100;
        }

        .sidebar-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }

        .conv-list {
            flex: 1;
            overflow-y: auto;
        }

        .main-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          position: relative;
        }

        .desktop-header {
          display: flex;
          justify-content: space-between;
          padding: 16px;
          border-bottom: 1px solid #222;
        }

        .mobile-header {
          display: none;
        }

        .messages-container {
          flex: 1;
          padding: 16px;
          overflow-y: auto;
        }

        .input-container {
          display: flex;
          gap: 10px;
          padding: 16px;
          border-top: 1px solid #222;
          background: #0b0b0b;
        }

        .chat-input {
          flex: 1;
          padding: 12px;
          border-radius: 12px;
          background: #0f0f0f;
          border: 1px solid #222;
          color: #fff;
          outline: none;
        }

        .mic-btn {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: 1px solid #222;
          color: #fff;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .send-btn {
          padding: 12px 16px;
          border-radius: 12px;
          border: 1px solid #b8860b;
          background: #b8860b;
          color: #000;
          cursor: pointer;
          font-weight: 800;
        }

        .mobile-only { display: none; }

        /* --- RESPONSIVE --- */
        @media (max-width: 768px) {
          .mobile-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 15px;
            background: #111;
            border-bottom: 1px solid #222;
            height: 60px;
          }

          .desktop-header { display: none; }

          .sidebar {
            position: fixed;
            left: 0;
            top: 0;
            bottom: 0;
            width: 85%;
            transform: translateX(-100%);
            transition: transform 0.3s ease;
            box-shadow: 10px 0 30px rgba(0,0,0,0.8);
          }

          .sidebar.open {
            transform: translateX(0);
          }

          .mobile-only { display: block; }

          .menu-trigger {
            background: none;
            border: none;
            color: #b8860b;
            font-size: 24px;
            cursor: pointer;
          }

          .close-btn {
            background: none;
            border: none;
            color: #fff;
            font-size: 20px;
          }

          .message-bubble {
            max-width: 90% !important;
          }

          .input-container {
            padding: 10px;
          }
          
          .send-btn {
            padding: 12px 10px;
            font-size: 13px;
          }
        }
      `}</style>
    </div>
  );
}

const btnSmall = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid #222",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
};
