// pages/chat.js
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { createClient } from "@supabase/supabase-js";

function createBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // IMPORTANT: ne pas throw côté serveur/build
  if (typeof window === "undefined") return null;

  if (!url || !anon) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
    return null;
  }
  return createClient(url, anon);
}

function isMeta(content) {
  return (
    typeof content === "string" &&
    (content.startsWith("__META_EMAIL_DRAFT__:") || content.startsWith("__META_EMAIL_SENT__:"))
  );
}

export default function ChatPage() {
  const router = useRouter();
  const agentSlug = typeof router.query.agent === "string" ? router.query.agent : "";

  const supabase = useMemo(() => createBrowserSupabase(), []);
  const [session, setSession] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const [loadingSend, setLoadingSend] = useState(false);
  const [errorBanner, setErrorBanner] = useState("");

  // ---- Auth/session
  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data?.session || null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession || null);
    });

    return () => sub?.subscription?.unsubscribe?.();
  }, [supabase]);

  // ---- Load conversations
  async function refreshConversations() {
    if (!supabase || !session?.user?.id) return;

    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, created_at, agent_slug")
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error(error);
      setErrorBanner("Erreur chargement conversations.");
      return;
    }
    setConversations(data || []);
  }

  useEffect(() => {
    if (!supabase || !session?.user?.id) return;
    refreshConversations();
  }, [supabase, session?.user?.id]);

  // ---- Load messages of a conversation
  async function loadMessages(conversationId) {
    if (!supabase || !conversationId) return;

    const { data, error } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) {
      console.error(error);
      setErrorBanner("Erreur chargement messages.");
      return;
    }

    const filtered = (data || []).filter((m) => !isMeta(m.content));
    setMessages(filtered);
  }

  // when selecting conversation
  useEffect(() => {
    if (!activeConversationId) return;
    loadMessages(activeConversationId);
  }, [activeConversationId]);

  // ---- Send message
  async function sendMessage() {
    setErrorBanner("");

    if (!agentSlug) {
      setErrorBanner("Aucun agent sélectionné. Utilisez /chat?agent=emma (ou autre).");
      return;
    }
    if (!session?.access_token) {
      setErrorBanner("Session absente. Veuillez vous reconnecter.");
      return;
    }

    const text = input.trim();
    if (!text) return;

    // optimistic add
    const optimisticUser = {
      id: `local-${Date.now()}`,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    setInput("");
    setLoadingSend(true);

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          agent_slug: agentSlug,
          conversation_id: activeConversationId,
          message: text,
        }),
      });

      const data = await r.json().catch(() => null);

      if (!r.ok || !data?.ok) {
        const err = data?.error || `Erreur API (${r.status})`;
        setErrorBanner(err);
        setLoadingSend(false);
        return;
      }

      const newConvId = data.conversation_id;
      if (!activeConversationId && newConvId) {
        setActiveConversationId(newConvId);
      }

      // Append assistant message
      const assistantText = data?.assistant?.text || "";
      if (assistantText) {
        setMessages((prev) => [
          ...prev,
          {
            id: `asst-${Date.now()}`,
            role: "assistant",
            content: assistantText,
            created_at: new Date().toISOString(),
          },
        ]);
      }

      await refreshConversations();
    } catch (e) {
      console.error(e);
      setErrorBanner("Erreur réseau lors de l’envoi du message.");
    } finally {
      setLoadingSend(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  async function startNewConversation() {
    setActiveConversationId(null);
    setMessages([]);
    setErrorBanner("");
    setInput("");
  }

  // ---- UI
  if (typeof window === "undefined") {
    // rendu build/SSR : rien (évite supabaseUrl required)
    return null;
  }

  if (!supabase) {
    return (
      <div style={{ padding: 24 }}>
        <h2>Configuration Supabase manquante</h2>
        <p>Vérifiez NEXT_PUBLIC_SUPABASE_URL et NEXT_PUBLIC_SUPABASE_ANON_KEY dans Vercel.</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={{ padding: 24 }}>
        <h2>Connexion requise</h2>
        <p>Veuillez vous connecter via votre écran de login Supabase.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "#070707", color: "#fff" }}>
      {/* Sidebar */}
      <div style={{ width: 320, borderRight: "1px solid #222", padding: 16, overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700 }}>Historique</div>
          <button
            onClick={startNewConversation}
            style={{
              background: "transparent",
              color: "#fff",
              border: "1px solid #444",
              padding: "6px 10px",
              borderRadius: 10,
              cursor: "pointer",
            }}
          >
            + Nouvelle
          </button>
        </div>

        <div style={{ marginTop: 12, fontSize: 12, opacity: 0.8 }}>
          Agent : <b>{agentSlug || "— (manquant)"}</b>
        </div>

        <div style={{ marginTop: 16 }}>
          {conversations.map((c) => (
            <div
              key={c.id}
              onClick={() => setActiveConversationId(c.id)}
              style={{
                padding: 10,
                marginBottom: 8,
                borderRadius: 12,
                border: activeConversationId === c.id ? "1px solid #b87333" : "1px solid #222",
                cursor: "pointer",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{c.title || "Conversation"}</div>
              <div style={{ fontSize: 11, opacity: 0.75 }}>
                {c.agent_slug} • {new Date(c.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 16, borderBottom: "1px solid #222" }}>
          <div style={{ fontWeight: 700 }}>Chat</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {activeConversationId ? `Conversation: ${activeConversationId}` : "Nouvelle conversation (créée au 1er message)"}
          </div>
        </div>

        {errorBanner ? (
          <div style={{ padding: 12, background: "#3a1111", borderBottom: "1px solid #552222" }}>
            {errorBanner}
          </div>
        ) : null}

        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                maxWidth: 900,
                marginBottom: 12,
                padding: 12,
                borderRadius: 14,
                background: m.role === "user" ? "#1b120a" : "#101010",
                border: m.role === "user" ? "1px solid #b87333" : "1px solid #222",
                marginLeft: m.role === "user" ? "auto" : 0,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
                {m.role === "user" ? "Vous" : "Agent"}
              </div>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.35 }}>{m.content}</div>
            </div>
          ))}
        </div>

        <div style={{ padding: 16, borderTop: "1px solid #222", display: "flex", gap: 10 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Écrire…"
            style={{
              flex: 1,
              minHeight: 44,
              maxHeight: 140,
              background: "#0d0d0d",
              color: "#fff",
              border: "1px solid #333",
              borderRadius: 14,
              padding: 12,
              resize: "none",
              outline: "none",
            }}
          />
          <button
            onClick={sendMessage}
            disabled={loadingSend}
            style={{
              width: 120,
              borderRadius: 14,
              border: "1px solid #b87333",
              background: loadingSend ? "#2a2a2a" : "#1b120a",
              color: "#fff",
              cursor: loadingSend ? "not-allowed" : "pointer",
              fontWeight: 700,
            }}
          >
            {loadingSend ? "Envoi…" : "Envoyer"}
          </button>
        </div>
      </div>
    </div>
  );
}
