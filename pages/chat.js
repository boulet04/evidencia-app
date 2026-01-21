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

  // 🎤 MICRO
  const recognitionRef = useRef(null);
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.lang = "fr-FR";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
      setListening(true);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognition.onerror = () => {
      setListening(false);
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setInput((prev) => (prev ? prev + " " + transcript : transcript));
    };

    recognitionRef.current = recognition;
  }, []);

  function toggleMic() {
    if (!recognitionRef.current) return;

    if (listening) {
      recognitionRef.current.stop();
    } else {
      recognitionRef.current.start();
    }
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
  }

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

  if (loading) return <div style={{ padding: 24 }}>Chargement…</div>;

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0b0b0b", color: "#fff" }}>
      {/* MAIN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
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

          {/* 🎤 MICRO */}
          <button
            onClick={toggleMic}
            title="Dicter un message"
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              border: "1px solid #222",
              background: listening ? "#8b0000" : "#111",
              color: "#fff",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14a3 3 0 003-3V5a3 3 0 10-6 0v6a3 3 0 003 3z" />
              <path d="M19 11a7 7 0 01-14 0h2a5 5 0 0010 0h2z" />
              <path d="M12 18v4h-2v-4h2z" />
            </svg>
          </button>

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
