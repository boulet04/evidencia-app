// pages/chat.js
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Chat() {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [agent, setAgent] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const threadRef = useRef(null);
  const canSend = useMemo(() => input.trim() && !sending, [input, sending]);

  const scrollBottom = () =>
    requestAnimationFrame(() => {
      if (threadRef.current)
        threadRef.current.scrollTop = threadRef.current.scrollHeight;
    });

  useEffect(() => {
    const boot = async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return (window.location.href = "/login");

      setUser(data.session.user);

      const agentSlug = new URL(window.location.href).searchParams.get("agent");
      if (!agentSlug) return (window.location.href = "/agents");

      const { data: agentData } = await supabase
        .from("agents")
        .select("*")
        .eq("slug", agentSlug)
        .single();

      setAgent(agentData);

      const { data: conv } = await supabase
        .from("conversations")
        .select("*")
        .eq("user_id", data.session.user.id)
        .eq("agent_slug", agentSlug)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      let convId = conv?.id;

      if (!convId) {
        const { data: newConv } = await supabase
          .from("conversations")
          .insert({
            user_id: data.session.user.id,
            agent_slug: agentSlug,
          })
          .select()
          .single();

        convId = newConv.id;
      }

      setConversationId(convId);

      const { data: msgs } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true });

      if (!msgs.length) {
        setMessages([
          {
            role: "assistant",
            content: `Bonjour, je suis ${agentData.name}. Comment puis-je vous aider ?`,
          },
        ]);
      } else {
        setMessages(msgs);
      }

      setLoading(false);
      scrollBottom();
    };

    boot();
  }, []);

  async function sendMessage() {
    if (!canSend) return;

    const text = input.trim();
    setInput("");
    setSending(true);

    setMessages((m) => [...m, { role: "user", content: text }]);
    scrollBottom();

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      user_id: user.id,
      role: "user",
      content: text,
    });

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        agentSlug: agent.slug,
        conversationId,
        userId: user.id,
      }),
    });

    const data = await res.json();
    setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
    setSending(false);
    scrollBottom();
  }

  if (loading) return null;

  return (
    <div className="chat-container">
      <div className="chat-thread" ref={threadRef}>
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            <strong>{m.role === "user" ? "Vous" : agent.name}</strong>
            <div>{m.content}</div>
          </div>
        ))}
      </div>

      <div className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
          placeholder="Votre message..."
        />
        <button disabled={!canSend} onClick={sendMessage}>
          Envoyer
        </button>
      </div>
    </div>
  );
}
