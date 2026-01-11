// pages/chat.js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { createClient } from "@supabase/supabase-js";

const DRAFT_OPEN = "[EMAIL_DRAFT_JSON]";
const DRAFT_CLOSE = "[/EMAIL_DRAFT_JSON]";

// IMPORTANT : pas de createClient() ici au top-level (sinon build Vercel peut casser)
let _supabase = null;

function getSupabaseClient() {
  if (typeof window === "undefined") return null; // SSR/build: on ne fait rien
  if (_supabase) return _supabase;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    // On ne throw pas ici pour éviter de casser l'app brutalement.
    // On gérera une erreur côté UI si besoin.
    return null;
  }

  _supabase = createClient(url, key);
  return _supabase;
}

function stripDraftBlock(text) {
  if (typeof text !== "string") return "";
  const start = text.lastIndexOf(DRAFT_OPEN);
  const end = text.lastIndexOf(DRAFT_CLOSE);
  if (start === -1 || end === -1 || end <= start) return text;
  return (text.slice(0, start) + text.slice(end + DRAFT_CLOSE.length)).trim();
}

export default function ChatPage() {
  const router = useRouter();

  const agentSlugFromUrl =
    typeof router.query.agent === "string" ? router.query.agent : null;
  const conversationIdFromUrl =
    typeof router.query.id === "string" ? router.query.id : null;

  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fatalEnvError, setFatalEnvError] = useState(false);

  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(
    conversationIdFromUrl || null
  );
  const [agentSlug, setAgentSlug] = useState(agentSlugFromUrl || null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const accessToken = session?.access_token || null;

  // Sync URL -> state
  useEffect(() => {
    if (agentSlugFromUrl) setAgentSlug(agentSlugFromUrl);
    if (conversationIdFromUrl) setConversationId(conversationIdFromUrl);
  }, [agentSlugFromUrl, conversationIdFromUrl]);

  // Session (client-side only)
  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setFatalEnvError(true);
      setLoading(false);
      return;
    }

    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(data?.session || null);
      setLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
      }
    );

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  async function refreshConversations(userId) {
    const supabase = getSupabaseClient();
    if (!supabase || !userId) return;

    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, created_at, agent_slug, archived")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (!error) setConversations(data || []);
  }

  async function refreshMessages(convId) {
    const supabase = getSupabaseClient();
    if (!supabase || !convId) return;

    const { data, error } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });

    if (!error) setMessages(data || []);
  }

  // Load conversations
  useEffect(() => {
    if (!session?.user?.id) return;
    refreshConversations(session.user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  // Load messages
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    refreshMessages(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const selectedConversation = useMemo(() => {
    return conversations.find((c) => c.id === conversationId) || null;
  }, [conversations, conversationId]);

  // Ensure agentSlug: from conversation if missing
  useEffect(() => {
    if (agentSlug) return;
    if (selectedConversation?.agent_slug) setAgentSlug(selectedConversation.agent_slug);
  }, [agentSlug, selectedConversation?.agent_slug]);

  async function startNewConversation() {
    const slug = agentSlugFromUrl || agentSlug;
    if (!slug) {
      alert("Aucun agent sélectionné. Ouvrez /chat?agent=emma (exemple).");
      return;
    }
    setConversationId(null);
    setMessages([]);
    router.push(`/chat?agent=${encodeURIComponent(slug)}`, undefined, {
      shallow: true,
    });
  }

  async function selectConversation(conv) {
    const slug = conv.agent_slug || agentSlugFromUrl || agentSlug;
    setAgentSlug(slug || null);
    setConversationId(conv.id);
    router.push(
      `/chat?agent=${encodeURIComponent(slug || "")}&id=${encodeURIComponent(
        conv.id
      )}`,
      undefined,
      { shallow: true }
    );
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;

    const slug =
      agentSlug || agentSlugFromUrl || selectedConversation?.agent_slug;

    if (!slug) {
      alert("Aucun agent sélectionné.");
      return;
    }
    if (!accessToken) {
      alert("Session invalide, reconnectez-vous.");
      return;
    }

    setSending(true);
    setInput("");

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          conversationId,
          agentSlug: slug,
          message: text,
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        alert(data?.error || "Erreur lors de l'envoi du message.");
        setSending(false);
        return;
      }

      // conversation créée côté backend au 1er message
      if (data.conversationId && data.conversationId !== conversationId) {
        setConversationId(data.conversationId);
        router.push(
          `/chat?agent=${encodeURIComponent(slug)}&id=${encodeURIComponent(
            data.conversationId
          )}`,
          undefined,
          { shallow: true }
        );
        await refreshConversations(session?.user?.id);
      }

      // Source de vérité : on relit depuis Supabase
      await refreshMessages(data.conversationId || conversationId);
    } catch (e) {
      alert("Erreur lors de l'envoi du message.");
    } finally {
      setSending(false);
    }
  }

  if (loading) return null;

  if (fatalEnvError) {
    return (
      <div style={{ padding: 24, background: "#0b0b0c", color: "#eee", height: "100vh" }}>
        <h3 style={{ marginTop: 0 }}>Configuration Supabase manquante</h3>
        <div style={{ opacity: 0.85, lineHeight: 1.5 }}>
          NEXT_PUBLIC_SUPABASE_URL ou NEXT_PUBLIC_SUPABASE_ANON_KEY est absent dans l'environnement.
          <br />
          Vérifie dans Vercel (Project → Settings → Environment Variables) puis redeploie.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "#0b0b0c", color: "#eee" }}>
      {/* Sidebar */}
      <div style={{ width: 320, borderRight: "1px solid rgba(255,255,255,0.08)", padding: 16 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <button
            onClick={startNewConversation}
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "transparent",
              color: "#eee",
            }}
          >
            + Nouvelle
          </button>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Agent: <strong>{agentSlug || "—"}</strong>
          </div>
        </div>

        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Historique</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", maxHeight: "calc(100vh - 90px)" }}>
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => selectConversation(c)}
              style={{
                textAlign: "left",
                padding: 10,
                borderRadius: 12,
                border:
                  c.id === conversationId
                    ? "1px solid rgba(200,140,60,0.65)"
                    : "1px solid rgba(255,255,255,0.10)",
                background:
                  c.id === conversationId ? "rgba(200,140,60,0.10)" : "transparent",
                color: "#eee",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{c.title || "Conversation"}</div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>{c.agent_slug || "—"}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 16, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {selectedConversation?.title || "Chat"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {conversationId
              ? `Conversation: ${conversationId}`
              : "Nouvelle conversation (sera créée au 1er message)"}
          </div>
        </div>

        <div style={{ flex: 1, padding: 16, overflowY: "auto" }}>
          {messages.map((m) => {
            const isUser = m.role === "user";
            const content = stripDraftBlock(String(m.content || ""));
            return (
              <div
                key={m.id}
                style={{
                  display: "flex",
                  justifyContent: isUser ? "flex-end" : "flex-start",
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    maxWidth: "70%",
                    padding: "10px 12px",
                    borderRadius: 14,
                    background: isUser ? "rgba(200,140,60,0.20)" : "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.35,
                  }}
                >
                  {content}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding: 16, borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", gap: 10 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Écrire…"
            style={{
              flex: 1,
              padding: "12px 12px",
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(0,0,0,0.35)",
              color: "#eee",
              outline: "none",
            }}
          />
          <button
            onClick={sendMessage}
            disabled={sending}
            style={{
              padding: "12px 16px",
              borderRadius: 14,
              border: "1px solid rgba(200,140,60,0.55)",
              background: sending ? "rgba(200,140,60,0.15)" : "rgba(200,140,60,0.25)",
              color: "#eee",
              cursor: sending ? "not-allowed" : "pointer",
              fontWeight: 700,
            }}
          >
            {sending ? "Envoi…" : "Envoyer"}
          </button>
        </div>
      </div>
    </div>
  );
}
