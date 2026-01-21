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

  const [user, setUser] = useState(null);
  const [agent, setAgent] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const endRef = useRef(null);

  // --- Micro ---
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    setSpeechSupported(true);

    const rec = new SR();
    rec.lang = "fr-FR";
    rec.continuous = false;
    rec.interimResults = false;

    rec.onresult = (e) => {
      const text = e?.results?.[0]?.[0]?.transcript?.trim();
      if (text) {
        setInput((prev) => (prev ? `${prev} ${text}` : text));
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    };

    rec.onend = () => setIsRecording(false);
    rec.onerror = () => setIsRecording(false);

    recognitionRef.current = rec;
    return () => rec.abort();
  }, []);

  function toggleDictation() {
    if (!speechSupported || !recognitionRef.current) return;
    if (isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
    } else {
      recognitionRef.current.start();
      setIsRecording(true);
    }
  }

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function fetchAgent() {
    const { data } = await supabase
      .from("agents")
      .select("id, slug, name, description, avatar_url")
      .eq("slug", agentSlug)
      .maybeSingle();
    return data;
  }

  async function fetchConversations(agentId, userId) {
    const { data } = await supabase
      .from("conversations")
      .select("id, created_at, title")
      .eq("agent_id", agentId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    return data || [];
  }

  async function createConversation(agentId, userId) {
    const { data } = await supabase
      .from("conversations")
      .insert({ agent_id: agentId, user_id: userId, title: "Conversation" })
      .select()
      .single();
    return data;
  }

  async function fetchMessages(conversationId) {
    const { data } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    return data || [];
  }

  async function insertMessage(conversationId, role, content) {
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role,
      content,
    });
  }

  useEffect(() => {
    if (!router.isReady) return;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data?.user) return (window.location.href = "/login");
      setUser(data.user);

      const a = await fetchAgent();
      setAgent(a);

      const convs = await fetchConversations(a.id, data.user.id);
      if (convs.length) setSelectedConversationId(convs[0].id);
      else {
        const c = await createConversation(a.id, data.user.id);
        setConversations([c]);
        setSelectedConversationId(c.id);
      }
      setConversations(convs);
      setLoading(false);
    })();
  }, [router.isReady, agentSlug]);

  useEffect(() => {
    if (!selectedConversationId) return;
    (async () => {
      const msgs = await fetchMessages(selectedConversationId);
      setMessages(msgs);
      if (!msgs.length && agent?.slug) {
        const first = getFirstMessage(agent.slug);
        if (first) {
          await insertMessage(selectedConversationId, "assistant", first);
          setMessages(await fetchMessages(selectedConversationId));
        }
      }
    })();
  }, [selectedConversationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    if (!input.trim() || sending) return;
    setSending(true);
    const text = input.trim();
    setInput("");

    await insertMessage(selectedConversationId, "user", text);
    setMessages(await fetchMessages(selectedConversationId));

    const token = await getAccessToken();
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ agentSlug, conversationId: selectedConversationId, message: text }),
    });

    const data = await res.json();
    if (data?.reply) {
      await insertMessage(selectedConversationId, "assistant", data.reply);
      setMessages(await fetchMessages(selectedConversationId));
    }
    setSending(false);
    inputRef.current?.focus();
  }

  if (loading) return null;

  return (
    <div style={{ minHeight: "100vh", background: "#050608", color: "#fff", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, padding: 16, overflowY: "auto" }}>
        {messages.map((m) => (
          <div key={m.id} style={{ textAlign: m.role === "user" ? "right" : "left", marginBottom: 12 }}>
            <div style={{
              display: "inline-block",
              padding: 14,
              borderRadius: 14,
              background: m.role === "user" ? "#b8860b" : "#0f0f0f",
              color: m.role === "user" ? "#000" : "#fff",
            }}>
              {m.content}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div style={{ padding: 16, display: "flex", gap: 10, borderTop: "1px solid #222" }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="Écrire..."
          style={{ flex: 1, padding: 12, borderRadius: 12, background: "#0f0f0f", color: "#fff", border: "1px solid #222" }}
        />

        <button onClick={toggleDictation} style={micBtn}>
          {isRecording ? stopIcon : micIcon}
        </button>

        <button onClick={sendMessage} style={btnPrimary}>Envoyer</button>
      </div>
    </div>
  );
}

/* ---------- ICONS ---------- */

const micIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="#000">
    <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"/>
    <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20h4v-2.08A7 7 0 0 0 19 11z"/>
  </svg>
);

const stopIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="#000">
    <rect x="6" y="6" width="12" height="12" rx="2"/>
  </svg>
);

/* ---------- STYLES ---------- */

const micBtn = {
  width: 46,
  height: 46,
  borderRadius: 14,
  border: "1px solid #b8860b",
  background: "#b8860b",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const btnPrimary = {
  padding: "12px 18px",
  borderRadius: 12,
  border: "1px solid #b8860b",
  background: "#b8860b",
  color: "#000",
  fontWeight: 800,
  cursor: "pointer",
};
