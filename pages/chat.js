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

  // --- Micro (dictée vocale) ---
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
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      try {
        const t = e?.results?.[0]?.[0]?.transcript || "";
        const chunk = String(t || "").trim();
        if (!chunk) return;
        setInput((prev) => (prev ? `${prev} ${chunk}` : chunk));
        setTimeout(() => inputRef.current?.focus?.(), 0);
      } catch (_) {}
    };

    rec.onend = () => setIsRecording(false);
    rec.onerror = () => setIsRecording(false);

    recognitionRef.current = rec;

    return () => {
      try {
        rec.abort();
      } catch (_) {}
      recognitionRef.current = null;
    };
  }, []);

  function toggleDictation() {
    if (!speechSupported) {
      alert("Dictée vocale non supportée sur ce navigateur.");
      return;
    }
    if (!recognitionRef.current) return;

    if (isRecording) {
      try {
        recognitionRef.current.stop();
      } catch (_) {}
      setIsRecording(false);
      return;
    }

    try {
      recognitionRef.current.start();
      setIsRecording(true);
    } catch (_) {
      setIsRecording(false);
    }
  }

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function fetchAgent() {
    const { data, error } = await supabase
      .from("agents")
      .select("id, slug, name, description, avatar_url")
      .eq("slug", agentSlug)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async function fetchConversations(agentId, userId) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, created_at, title")
      .eq("agent_id", agentId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async function createConversation(agentId, userId) {
    const { data, error } = await supabase
      .from("conversations")
      .insert({
        agent_id: agentId,
        user_id: userId,
        title: "Conversation",
      })
      .select("id, created_at, title")
      .single();

    if (error) throw error;
    return data;
  }

  async function fetchMessages(conversationId) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async function insertMessage(conversationId, role, content) {
    const { error } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      role,
      content,
    });
    if (error) throw error;
  }

  async function boot() {
    setLoading(true);
    setError("");
    try {
      const { data } = await supabase.auth.getUser();
      const u = data?.user || null;
      if (!u) {
        window.location.href = "/login";
        return;
      }
      setUser(u);

      const a = await fetchAgent();
      if (!a) {
        setError("Agent introuvable.");
        setLoading(false);
        return;
      }
      setAgent(a);

      const convs = await fetchConversations(a.id, u.id);
      setConversations(convs);

      if (convs.length) {
        setSelectedConversationId(convs[0].id);
      } else {
        const created = await createConversation(a.id, u.id);
        setConversations([created]);
        setSelectedConversationId(created.id);
      }
    } catch (e) {
      setError(e?.message || "Erreur interne API");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!router.isReady) return;
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, agentSlug]);

  useEffect(() => {
    if (!selectedConversationId) return;
    (async () => {
      setError("");
      try {
        const msgs = await fetchMessages(selectedConversationId);
        setMessages(msgs);

        // auto 1er message si conversation vide
        if (!msgs.length && agent?.slug) {
          const first = getFirstMessage(agent.slug);
          if (first) {
            await insertMessage(selectedConversationId, "assistant", first);
            const updated = await fetchMessages(selectedConversationId);
            setMessages(updated);
          }
        }
      } catch (e) {
        setError(e?.message || "Erreur interne API");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversationId]);

  useEffect(() => {
    try {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    } catch (_) {}
  }, [messages]);

  async function sendMessage() {
    const text = String(input || "").trim();
    if (!text || !selectedConversationId || sending) return;

    setSending(true);
    setError("");

    try {
      await insertMessage(selectedConversationId, "user", text);
      setInput("");

      const afterUser = await fetchMessages(selectedConversationId);
      setMessages(afterUser);

      const token = await getAccessToken();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agentSlug,
          conversationId: selectedConversationId,
          message: text,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "Erreur interne API");
      }

      const reply = data?.reply || "";
      if (reply) {
        await insertMessage(selectedConversationId, "assistant", reply);
      }

      const afterAssistant = await fetchMessages(selectedConversationId);
      setMessages(afterAssistant);
    } catch (e) {
      setError(e?.message || "Erreur interne API");
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus?.(), 0);
    }
  }

  function startNewConversation() {
    if (!agent?.id || !user?.id) return;
    (async () => {
      setError("");
      try {
        const created = await createConversation(agent.id, user.id);
        setConversations((prev) => [created, ...prev]);
        setSelectedConversationId(created.id);
        setMessages([]);
      } catch (e) {
        setError(e?.message || "Erreur interne API");
      }
    })();
  }

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#050608", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
        Chargement…
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#050608", color: "#fff", display: "flex" }}>
      <div style={{ width: 280, borderRight: "1px solid #222", padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <button onClick={() => (window.location.href = "/agents")} style={btnSmall}>
            Retour aux agents
          </button>
          <button onClick={startNewConversation} style={btnSmall}>
            + Nouvelle
          </button>
        </div>

        <div style={{ fontWeight: 800, marginBottom: 10 }}>Historique</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedConversationId(c.id)}
              style={{
                textAlign: "left",
                padding: 12,
                borderRadius: 12,
                border: selectedConversationId === c.id ? "1px solid #b8860b" : "1px solid #222",
                background: "#0f0f0f",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 800 }}>{c.title || "Conversation"}</div>
              <div style={{ opacity: 0.7, fontSize: 12 }}>{new Date(c.created_at).toLocaleString()}</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 16, borderBottom: "1px solid #222", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {agent?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={agent.avatar_url} alt={agent.name} style={{ width: 36, height: 36, borderRadius: 999, objectFit: "cover" }} />
            ) : (
              <div style={{ width: 36, height: 36, borderRadius: 999, background: "#111", border: "1px solid #222" }} />
            )}
            <div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>{agent?.name || "Agent"}</div>
              <div style={{ opacity: 0.7, fontSize: 12 }}>{agent?.description || ""}</div>
            </div>
          </div>

          <button
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.href = "/login";
            }}
            style={btnSmall}
          >
            Déconnexion
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
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
                  maxWidth: 760,
                  whiteSpace: "pre-wrap",
                  padding: 14,
                  borderRadius: 14,
                  background: m.role === "user" ? "#b8860b" : "#0f0f0f",
                  color: m.role === "user" ? "#000" : "#fff",
                  border: m.role === "user" ? "1px solid #b8860b" : "1px solid #222",
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
            ref={inputRef}
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

          <button
            type="button"
            onClick={toggleDictation}
            disabled={!speechSupported || sending}
            title={
              speechSupported
                ? isRecording
                  ? "Arrêter la dictée"
                  : "Dictée vocale"
                : "Dictée vocale non supportée"
            }
            style={{ ...btnSmall, opacity: !speechSupported || sending ? 0.6 : 1, fontSize: 16, padding: "12px 14px" }}
          >
            {isRecording ? "⏺" : "🎙"}
          </button>

          <button onClick={sendMessage} style={{ ...btnPrimary, opacity: sending ? 0.7 : 1 }} disabled={sending}>
            {sending ? "Envoi..." : "Envoyer"}
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
