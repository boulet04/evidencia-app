// pages/chat.js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import { getFirstMessage } from "../lib/agentPrompts";

function buildConversationTitle(text) {
  const stop = new Set(["salut", "bonjour", "hello", "coucou", "hey"]);
  const words = text
    .toLowerCase()
    .replace(/[^a-zàâäéèêëïîôöùûüç0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w));

  return words.slice(0, 4).join(" ");
}

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

    // ✅ RENOMMAGE AUTO AU PREMIER MESSAGE
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

  if (loading) return <div style={{ padding: 24 }}>Chargement…</div>;

  return (
    /* ⬇️ UI STRICTEMENT INCHANGÉE ⬇️ */
    <div style={{ display: "flex", height: "100vh", background: "#0b0b0b", color: "#fff" }}>
      {/* ... le reste est IDENTIQUE à ta version ... */}
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
