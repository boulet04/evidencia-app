import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

function formatTitleFallback(agentName) {
  if (!agentName) return "Nouvelle conversation";
  return `Discussion avec ${agentName}`;
}

function defaultWelcome(agentName) {
  if (!agentName) return "Bonjour, comment puis-je vous aider aujourd'hui ?";
  return `Bonjour, je suis ${agentName}. Comment puis-je vous aider aujourd'hui ?`;
}

export default function ChatAgentSlug() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const [user, setUser] = useState(null);

  const [agent, setAgent] = useState(null);
  const [loadingAgent, setLoadingAgent] = useState(true);

  const [conversations, setConversations] = useState([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [creatingConv, setCreatingConv] = useState(false);

  const [selectedConversationId, setSelectedConversationId] = useState("");
  const selectedConversation = useMemo(
    () => conversations.find((c) => c.id === selectedConversationId),
    [conversations, selectedConversationId]
  );

  const [messages, setMessages] = useState([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const messagesEndRef = useRef(null);

  // Auth
  useEffect(() => {
    let mounted = true;

    async function loadUser() {
      const { data } = await supabase.auth.getSession();
      const u = data?.session?.user || null;
      if (!mounted) return;
      setUser(u);
      if (!u) router.push("/login");
    }

    loadUser();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setUser(session?.user || null);
      if (!session?.user) router.push("/login");
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, [router]);

  // Load agent by slug
  useEffect(() => {
    async function loadAgent() {
      if (!agentSlug || typeof agentSlug !== "string") return;
      setLoadingAgent(true);
      try {
        const { data, error } = await supabase
          .from("agents")
          .select("*")
          .eq("slug", agentSlug)
          .maybeSingle();

        if (error) throw error;
        setAgent(data || null);
      } catch (e) {
        console.error(e);
        setAgent(null);
      } finally {
        setLoadingAgent(false);
      }
    }
    loadAgent();
  }, [agentSlug]);

  // Load conversations for user + agent_slug
  useEffect(() => {
    async function loadConversations() {
      if (!user?.id) return;
      if (!agentSlug || typeof agentSlug !== "string") return;

      setLoadingConvs(true);
      try {
        const { data, error } = await supabase
          .from("conversations")
          .select("*")
          .eq("user_id", user.id)
          .eq("agent_slug", agentSlug)
          .order("created_at", { ascending: false });

        if (error) throw error;
        setConversations(data || []);

        // auto-select first conversation
        if ((data || []).length > 0 && !selectedConversationId) {
          setSelectedConversationId(data[0].id);
        }
      } catch (e) {
        console.error(e);
        setConversations([]);
      } finally {
        setLoadingConvs(false);
      }
    }

    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, agentSlug]);

  // Load messages for selected conversation
  useEffect(() => {
    async function loadMessages() {
      if (!selectedConversationId) {
        setMessages([]);
        return;
      }
      setLoadingMsgs(true);
      try {
        const { data, error } = await supabase
          .from("messages")
          .select("*")
          .eq("conversation_id", selectedConversationId)
          .order("created_at", { ascending: true });

        if (error) throw error;
        setMessages(data || []);
      } catch (e) {
        console.error(e);
        setMessages([]);
      } finally {
        setLoadingMsgs(false);
      }
    }
    loadMessages();
  }, [selectedConversationId]);

  // Auto scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loadingMsgs]);

  async function handleNewConversation() {
    if (!user?.id) return;
    if (!agentSlug || typeof agentSlug !== "string") return;

    try {
      setCreatingConv(true);

      const title = formatTitleFallback(agent?.name);
      const { data, error } = await supabase
        .from("conversations")
        .insert([
          {
            user_id: user.id,
            agent_slug: agentSlug,
            title,
          },
        ])
        .select("*")
        .single();

      if (error) throw error;

      // Ensure welcome message exists
      const welcome = agent?.welcome_message || defaultWelcome(agent?.name);
      await supabase.from("messages").insert([
        {
          conversation_id: data.id,
          role: "assistant",
          content: welcome,
        },
      ]);

      // refresh
      setConversations((prev) => [data, ...prev]);
      setSelectedConversationId(data.id);
    } catch (e) {
      console.error(e);
      alert("Erreur lors de la création de la conversation.");
    } finally {
      setCreatingConv(false);
    }
  }

  async function handleDeleteConversation(convId) {
    if (!convId) return;
    if (!confirm("Supprimer cette conversation ?")) return;

    try {
      // delete messages first
      await supabase.from("messages").delete().eq("conversation_id", convId);
      // then conversation
      const { error } = await supabase.from("conversations").delete().eq("id", convId);
      if (error) throw error;

      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (selectedConversationId === convId) {
        setSelectedConversationId("");
        setMessages([]);
      }
    } catch (e) {
      console.error(e);
      alert("Erreur lors de la suppression.");
    }
  }

  async function handleSend() {
    const text = (input || "").trim();
    if (!text) return;
    if (!selectedConversationId) return;

    setSending(true);
    try {
      // Insert user message
      const { data: msgData, error: msgErr } = await supabase
        .from("messages")
        .insert([
          {
            conversation_id: selectedConversationId,
            role: "user",
            content: text,
          },
        ])
        .select("*")
        .single();

      if (msgErr) throw msgErr;
      setMessages((prev) => [...prev, msgData]);
      setInput("");

      // Call API
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: selectedConversationId,
          agentSlug,
          message: text,
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json?.error || "Erreur interne API";
        throw new Error(msg);
      }

      const reply = json?.reply || "";
      if (!reply) return;

      // Insert assistant reply
      const { data: asData, error: asErr } = await supabase
        .from("messages")
        .insert([
          {
            conversation_id: selectedConversationId,
            role: "assistant",
            content: reply,
          },
        ])
        .select("*")
        .single();

      if (asErr) throw asErr;
      setMessages((prev) => [...prev, asData]);
    } catch (e) {
      console.error(e);
      alert(e?.message || "Erreur interne API");
    } finally {
      setSending(false);
    }
  }

  const title = agent?.name ? `${agent.name} — Chat` : "Chat";

  return (
    <div className="page">
      <div className="topbar">
        <button className="btn back" onClick={() => router.push("/agents")}>
          ← Retour
        </button>

        <div className="brand">
          <div className="brandTitle">Evidenc’IA</div>
        </div>

        <div className="topbarRight">
          <div className="pill">{user?.email || "—"}</div>
          <button
            className="btn logout"
            onClick={async () => {
              await supabase.auth.signOut();
              router.push("/login");
            }}
          >
            Déconnexion
          </button>
        </div>
      </div>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebarHeader">
            <div className="sidebarTitle">Historique</div>
            <button className="btn small" onClick={handleNewConversation} disabled={creatingConv}>
              {creatingConv ? "..." : "+ Nouvelle"}
            </button>
          </div>

          <div className="sidebarBody">
            {loadingConvs ? (
              <div className="muted">Chargement…</div>
            ) : conversations.length === 0 ? (
              <div className="muted">Aucune conversation.</div>
            ) : (
              conversations.map((c) => {
                const active = c.id === selectedConversationId;
                return (
                  <div
                    key={c.id}
                    className={`convItem ${active ? "active" : ""}`}
                    onClick={() => setSelectedConversationId(c.id)}
                  >
                    <div className="convTitle">{c.title || "Conversation"}</div>
                    <div className="convMeta">
                      {(c.created_at || "").slice(0, 10)} {(c.created_at || "").slice(11, 19)}
                    </div>
                    <button
                      className="convDelete"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteConversation(c.id);
                      }}
                      title="Supprimer"
                    >
                      ×
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <main className="main">
          <div className="chatHeader">
            <div className="chatTitle">{loadingAgent ? "…" : title}</div>
            <div className="chatSub">{agent?.tagline || "—"}</div>
          </div>

          <div className="chatBody">
            {loadingMsgs ? (
              <div className="muted">Chargement des messages…</div>
            ) : messages.length === 0 ? (
              <div className="muted">Aucun message.</div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`msgRow ${m.role === "user" ? "user" : "assistant"}`}>
                  <div className="msgBubble">{m.content}</div>
                </div>
              ))
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="chatInputWrap">
            <div className="chatInput">
              <input
                className="input"
                placeholder="Écrire…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                disabled={!selectedConversationId || sending}
              />

              {/* Bouton micro (dictée vocale) */}
              <button
                className="btn mic"
                type="button"
                aria-label="Micro"
                title="Dictée vocale (à connecter)"
                onClick={() => alert("Dictée vocale: à connecter à ton module voix.")}
              >
                <svg className="micIcon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M19 11a7 7 0 0 1-14 0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 18v3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M8 21h8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              <button
                className="btn send"
                onClick={handleSend}
                disabled={!selectedConversationId || sending}
              >
                {sending ? "Envoi..." : "Envoyer"}
              </button>
            </div>

            <div className="chatFooter">
              <div className="mutedSmall">
                {selectedConversation ? `Conversation: ${selectedConversation.id}` : ""}
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Minimal styles (tu peux les basculer dans ton CSS global si tu préfères) */}
      <style jsx>{`
        .page {
          min-height: 100vh;
          background: #050608;
          color: #e9eef6;
        }

        .topbar {
          height: 64px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          background: radial-gradient(
            1200px 200px at 50% -20%,
            rgba(255, 130, 30, 0.18),
            transparent
          );
        }

        .brandTitle {
          font-weight: 800;
          letter-spacing: 0.2px;
        }

        .topbarRight {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .pill {
          border: 1px solid rgba(255, 255, 255, 0.12);
          padding: 8px 10px;
          border-radius: 999px;
          font-size: 12px;
          opacity: 0.9;
        }

        .btn {
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.04);
          color: #e9eef6;
          padding: 10px 12px;
          border-radius: 14px;
          cursor: pointer;
          font-weight: 600;
        }

        .btn.mic {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 10px 10px;
        }

        .micIcon {
          width: 18px;
          height: 18px;
          display: block;
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .btn.logout {
          border-radius: 999px;
        }

        .btn.back {
          border-radius: 999px;
        }

        .btn.small {
          padding: 8px 10px;
          border-radius: 999px;
          font-size: 12px;
          opacity: 0.9;
        }

        .layout {
          display: grid;
          grid-template-columns: 340px 1fr;
          gap: 16px;
          padding: 16px;
        }

        .sidebar {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 18px;
          min-height: calc(100vh - 64px - 32px);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .sidebarHeader {
          padding: 14px 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }

        .sidebarTitle {
          font-weight: 800;
          letter-spacing: 0.2px;
        }

        .sidebarBody {
          padding: 10px;
          overflow: auto;
        }

        .convItem {
          position: relative;
          border: 1px solid rgba(255, 255, 255, 0.06);
          background: rgba(255, 255, 255, 0.02);
          border-radius: 16px;
          padding: 10px 12px;
          margin-bottom: 10px;
          cursor: pointer;
        }

        .convItem.active {
          border-color: rgba(255, 140, 40, 0.5);
          background: rgba(255, 140, 40, 0.08);
        }

        .convTitle {
          font-weight: 700;
          font-size: 13px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          padding-right: 34px;
        }

        .convMeta {
          font-size: 11px;
          opacity: 0.6;
          margin-top: 2px;
        }

        .convDelete {
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
          width: 30px;
          height: 30px;
          border-radius: 12px;
          border: 1px solid rgba(255, 60, 60, 0.35);
          background: rgba(255, 60, 60, 0.12);
          color: rgba(255, 210, 210, 0.95);
          font-size: 20px;
          line-height: 0;
          cursor: pointer;
        }

        .main {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 18px;
          min-height: calc(100vh - 64px - 32px);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .chatHeader {
          padding: 14px 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }

        .chatTitle {
          font-weight: 900;
          letter-spacing: 0.2px;
        }

        .chatSub {
          font-size: 12px;
          opacity: 0.65;
          margin-top: 4px;
        }

        .chatBody {
          padding: 14px 16px;
          overflow: auto;
          flex: 1;
        }

        .msgRow {
          display: flex;
          margin: 10px 0;
        }

        .msgRow.user {
          justify-content: flex-end;
        }

        .msgRow.assistant {
          justify-content: flex-start;
        }

        .msgBubble {
          max-width: min(720px, 86%);
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.03);
          padding: 14px 16px;
          border-radius: 18px;
          line-height: 1.45;
          white-space: pre-wrap;
        }

        .msgRow.user .msgBubble {
          border-color: rgba(255, 140, 40, 0.22);
          background: rgba(255, 140, 40, 0.12);
        }

        .chatInputWrap {
          padding: 14px 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
        }

        .chatInput {
          display: grid;
          grid-template-columns: 1fr auto auto;
          gap: 10px;
          align-items: center;
        }

        .input {
          width: 100%;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.02);
          color: #e9eef6;
          border-radius: 16px;
          padding: 14px 14px;
          outline: none;
          font-size: 14px;
        }

        .btn.send {
          border-color: rgba(255, 140, 40, 0.55);
          background: rgba(255, 140, 40, 0.22);
        }

        .chatFooter {
          margin-top: 10px;
          display: flex;
          justify-content: space-between;
        }

        .muted {
          opacity: 0.7;
        }
        .mutedSmall {
          opacity: 0.55;
          font-size: 11px;
        }

        @media (max-width: 900px) {
          .layout {
            grid-template-columns: 1fr;
          }
          .sidebar {
            min-height: auto;
          }
          .main {
            min-height: 60vh;
          }
        }
      `}</style>
    </div>
  );
}
