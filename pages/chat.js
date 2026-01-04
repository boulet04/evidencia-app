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

  /* ================= HELPERS ================= */

  function safeDecode(v) {
    try {
      return decodeURIComponent(v || "");
    } catch {
      return v || "";
    }
  }

  function formatTitleFromFirstUserMessage(text) {
    const t = (text || "").trim().replace(/\s+/g, " ");
    if (!t) return "Nouvelle conversation";
    return t.length > 42 ? t.slice(0, 42) + "…" : t;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (threadRef.current) {
        threadRef.current.scrollTop = threadRef.current.scrollHeight;
      }
    });
  }

  /* ================= SUPABASE ================= */

  async function fetchAgent(slug) {
    const { data, error } = await supabase
      .from("agents")
      .select("slug, name, description, avatar_url")
      .eq("slug", slug)
      .maybeSingle();

    return error ? null : data;
  }

  async function fetchHistory({ uid, agentSlug }) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, updated_at")
      .eq("user_id", uid)
      .eq("agent_slug", agentSlug)
      .order("updated_at", { ascending: false })
      .limit(10);

    return error ? [] : data;
  }

  async function fetchMessages({ convId }) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });

    return error ? [] : data;
  }

  async function createConversation({ uid, agentSlug, title }) {
    const { data, error } = await supabase
      .from("conversations")
      .insert({
        user_id: uid,
        agent_slug: agentSlug,
        title: title || "Nouvelle conversation",
      })
      .select("id")
      .single();

    return error ? null : data.id;
  }

  async function touchConversation({ uid, convId, titleMaybe }) {
    const patch = { updated_at: new Date().toISOString() };
    if (titleMaybe) patch.title = titleMaybe;

    await supabase
      .from("conversations")
      .update(patch)
      .eq("id", convId)
      .eq("user_id", uid);
  }

  async function insertMessage({ convId, role, content }) {
    await supabase.from("messages").insert({
      conversation_id: convId,
      role,
      content,
    });
  }

  /* ================= BOOT ================= */

  useEffect(() => {
    let mounted = true;

    async function boot() {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        window.location.href = "/login";
        return;
      }

      const uid = data.session.user.id;
      setUserId(uid);
      setEmail(data.session.user.email || "");

      const url = new URL(window.location.href);
      const slug = safeDecode(url.searchParams.get("agent")).toLowerCase();
      if (!slug) return (window.location.href = "/agents");

      const a = await fetchAgent(slug);
      if (!a) return (window.location.href = "/agents");
      setAgent(a);

      const historyData = await fetchHistory({ uid, agentSlug: a.slug });
      setHistory(historyData);

      let convId =
        url.searchParams.get("c") ||
        (historyData[0] ? historyData[0].id : null);

      if (!convId) {
        convId = await createConversation({
          uid,
          agentSlug: a.slug,
          title: "Nouvelle conversation",
        });
      }

      setConversationId(convId);

      const msgs = await fetchMessages({ convId });
      setMessages(
        msgs.length
          ? msgs
          : [{ role: "assistant", content: `Bonjour, je suis ${a.name}. Comment puis-je vous aider ?` }]
      );

      setLoading(false);
      scrollToBottom();
    }

    boot();

    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      if (!s) window.location.href = "/login";
    });

    return () => {
      mounted = false;
      data?.subscription?.unsubscribe();
    };
  }, []);

  /* ================= ACTIONS ================= */

  async function sendMessage() {
    if (!conversationId || !canSend) return;

    const userText = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", content: userText }]);
    setSending(true);

    await insertMessage({
      convId: conversationId,
      role: "user",
      content: userText,
    });

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText, agentSlug: agent.slug }),
      });

      const data = await resp.json();
      const reply = data.reply || "Réponse vide.";

      setMessages((m) => [...m, { role: "assistant", content: reply }]);
      await insertMessage({
        convId: conversationId,
        role: "assistant",
        content: reply,
      });

      await touchConversation({
        uid: userId,
        convId: conversationId,
        titleMaybe:
          messages.filter((m) => m.role === "user").length === 0
            ? formatTitleFromFirstUserMessage(userText)
            : null,
      });

      setHistory(await fetchHistory({ uid: userId, agentSlug: agent.slug }));
      scrollToBottom();
    } catch {
      setErrorMsg("Erreur interne.");
    } finally {
      setSending(false);
    }
  }

  /* ================= UI ================= */

  if (loading) return null;

  return (
    <main>
      {/* UI inchangée — ton design est conservé */}
    </main>
  );
}
