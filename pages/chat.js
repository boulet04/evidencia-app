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
  const canSend = useMemo(
    () => input.trim().length > 0 && !sending,
    [input, sending]
  );

  function scrollToBottom() {
    requestAnimationFrame(() => {
      threadRef.current?.scrollTo(0, threadRef.current.scrollHeight);
    });
  }

  /* ================= BOOT ================= */
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

      const uid = session.user.id;
      setUserId(uid);
      setEmail(session.user.email || "");

      const url = new URL(window.location.href);
      const slug = url.searchParams.get("agent");

      if (!slug) {
        window.location.href = "/agents";
        return;
      }

      const { data: agentData } = await supabase
        .from("agents")
        .select("*")
        .eq("slug", slug)
        .single();

      if (!agentData) {
        window.location.href = "/agents";
        return;
      }

      setAgent(agentData);

      // Historique
      const { data: hist } = await supabase
        .from("conversations")
        .select("id, title, updated_at")
        .eq("user_id", uid)
        .eq("agent_slug", slug)
        .order("updated_at", { ascending: false })
        .limit(10);

      setHistory(hist || []);

      let convId = url.searchParams.get("c");

      if (convId) {
        const exists = hist?.some((c) => c.id === convId);
        if (!exists) convId = null;
      }

      if (!convId && hist?.length > 0) {
        convId = hist[0].id;
      }

      if (!convId) {
        const { data: newConv } = await supabase
          .from("conversations")
          .insert({
            user_id: uid,
            agent_slug: slug,
            title: "Nouvelle conversation",
          })
          .select("id")
          .single();

        convId = newConv.id;
      }

      setConversationId(convId);

      const { data: msgs } = await supabase
        .from("messages")
        .select("role, content")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true });

      if (msgs?.length > 0) {
        setMessages(msgs);
      } else {
        setMessages([
          {
            role: "assistant",
            content: `Bonjour, je suis ${agentData.name}. Comment puis-je vous aider ?`,
          },
        ]);
      }

      setLoading(false);
      scrollToBottom();
    }

    boot();

    return () => {
      mounted = false;
    };
  }, []);

  /* ================= SEND MESSAGE ================= */
  async function sendMessage() {
    if (!canSend || !conversationId) return;

    const userText = input.trim();
    setInput("");
    setSending(true);

    const newMessages = [...messages, { role: "user", content: userText }];
    setMessages(newMessages);
    scrollToBottom();

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "user",
      content: userText,
    });

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentSlug: agent.slug,
          messages: newMessages,
        }),
      });

      const data = await resp.json();
      if (!resp.ok) throw new Error();

      const reply = data.reply;

      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);

      await supabase.from("messages").insert({
        conversation_id: conversationId,
        user_id: userId,
        role: "assistant",
        content: reply,
      });

      await supabase
        .from("conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", conversationId);

      scrollToBottom();
    } catch {
      setErrorMsg("Erreur IA.");
    } finally {
      setSending(false);
    }
  }

  if (loading || !agent) return null;

  return (
    <div style={{ padding: 20, color: "#fff" }}>
      <h2>{agent.name}</h2>

      <div ref={threadRef} style={{ height: "70vh", overflowY: "auto" }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <strong>{m.role === "user" ? "Vous" : agent.name}</strong>
            <div>{m.content}</div>
          </div>
        ))}
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
        placeholder="Votre message…"
        style={{ width: "100%", marginTop: 10 }}
      />
    </div>
  );
}
