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
  // Tu peux ajuster le wording ici si tu veux une variante par agent
  return "Bonjour, comment puis-je vous aider?";
}

export default function ChatAgentPage() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);

  const [agent, setAgent] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const [loadingConvs, setLoadingConvs] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [creatingConv, setCreatingConv] = useState(false);
  const [sending, setSending] = useState(false);

  const messagesEndRef = useRef(null);

  const [err, setErr] = useState("");

  const baseSystemPrompt = useMemo(() => {
    // Le prompt global est géré côté API (/api/chat.js)
    return "";
  }, []);

  // Session
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const s = data?.session || null;
      setSession(s);
      setUser(s?.user || null);
      if (!s?.user) {
        router.push("/login");
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
      setUser(s?.user || null);
      if (!s?.user) router.push("/login");
    });

    return () => {
      sub?.subscription?.unsubscribe?.();
    };
  }, [router]);

  // Load agent by slug
  useEffect(() => {
    if (!agentSlug || typeof agentSlug !== "string") return;

    (async () => {
      setErr("");
      const { data, error } = await supabase
        .from("agents")
        .select("id,slug,name,role,avatar_url,description")
        .eq("slug", agentSlug)
        .maybeSingle();

      if (error) {
        setErr(error.message || "Erreur chargement agent");
        setAgent(null);
        return;
      }
      setAgent(data || null);
    })();
  }, [agentSlug]);

  // Load conversations for this user + agentSlug
  useEffect(() => {
    if (!user?.id) return;
    if (!agentSlug || typeof agentSlug !== "string") return;

    (async () => {
      setLoadingConvs(true);
      setErr("");

      const { data, error } = await supabase
        .from("conversations")
        .select("id,title,created_at,archived")
        .eq("user_id", user.id)
        .eq("agent_slug", agentSlug)
        .order("created_at", { ascending: false });

      setLoadingConvs(false);

      if (error) {
        setErr(error.message || "Erreur chargement conversations");
        setConversations([]);
        setSelectedConversationId(null);
        return;
      }

      const rows = data || [];
      setConversations(rows);

      // Auto-select latest non-archived or first
      const first = rows.find((r) => !r.archived) || rows[0] || null;
      setSelectedConversationId(first?.id || null);
    })();
  }, [user?.id, agentSlug]);

  // Load messages for selected conversation
  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      return;
    }

    (async () => {
      setLoadingMsgs(true);
      const { data, error } = await supabase
        .from("messages")
        .select("id,role,content,created_at")
        .eq("conversation_id", selectedConversationId)
        .order("created_at", { ascending: true });

      setLoadingMsgs(false);

      if (error) {
        setErr(error.message || "Erreur chargement messages");
        setMessages([]);
        return;
      }
      setMessages(data || []);
    })();
  }, [selectedConversationId]);

  // Scroll to bottom
  useEffect(() => {
    if (!messagesEndRef.current) return;
    messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length, loadingMsgs]);

  function logout() {
    supabase.auth.signOut();
    router.push("/login");
  }

  async function createConversation() {
    if (!user?.id) return;
    if (!agentSlug || typeof agentSlug !== "string") return;

    setCreatingConv(true);
    setErr("");

    const title = formatTitleFallback(agent?.name);

    const { data, error } = await supabase
      .from("conversations")
      .insert([
        {
          user_id: user.id,
          agent_slug: agentSlug,
          title,
          archived: false,
        },
      ])
      .select("id,title,created_at,archived")
      .maybeSingle();

    setCreatingConv(false);

    if (error) {
      setErr(error.message || "Erreur création conversation");
      return;
    }

    // add welcome message locally (optional)
    const welcome = defaultWelcome(agent?.name);

    if (data?.id) {
      // persist welcome as assistant message
      await supabase.from("messages").insert([
        {
          conversation_id: data.id,
          role: "assistant",
          content: welcome,
        },
      ]);
    }

    // Refresh conversations list
    const { data: convs } = await supabase
      .from("conversations")
      .select("id,title,created_at,archived")
      .eq("user_id", user.id)
      .eq("agent_slug", agentSlug)
      .order("created_at", { ascending: false });

    const rows = convs || [];
    setConversations(rows);
    setSelectedConversationId(data?.id || rows[0]?.id || null);
  }

  async function selectConversation(id) {
    setSelectedConversationId(id);
  }

  async function sendMessage() {
    if (!user?.id) return;
    if (!selectedConversationId) {
      // no conversation selected => create one
      await createConversation();
      return;
    }

    const text = String(input || "").trim();
    if (!text) return;

    setSending(true);
    setErr("");

    // Insert user message in db
    const { error: msgErr } = await supabase.from("messages").insert([
      {
        conversation_id: selectedConversationId,
        role: "user",
        content: text,
      },
    ]);

    if (msgErr) {
      setSending(false);
      setErr(msgErr.message || "Erreur envoi message");
      return;
    }

    // Optimistic UI: append
    setMessages((prev) => [
      ...(prev || []),
      {
        id: `tmp-${Date.now()}`,
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      },
    ]);

    setInput("");

    // Call API (uses global prompt + personal prompt in DB)
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentSlug,
          conversationId: selectedConversationId,
          message: text,
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || `Erreur API (${res.status})`);
      }

      const reply = json?.reply || "";
      if (reply) {
        // Insert assistant message
        const { error: insErr } = await supabase.from("messages").insert([
          {
            conversation_id: selectedConversationId,
            role: "assistant",
            content: reply,
          },
        ]);

        if (insErr) {
          setErr(insErr.message || "Erreur sauvegarde réponse");
        }

        setMessages((prev) => [
          ...(prev || []),
          {
            id: `tmp-a-${Date.now()}`,
            role: "assistant",
            content: reply,
            created_at: new Date().toISOString(),
          },
        ]);
      }
    } catch (e) {
      setErr(e?.message || "Erreur interne API");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sending) sendMessage();
    }
  }

  return (
    <div className="page">
      <div className="topbar">
        <div className="brand">
          <button
            className="btn back"
            type="button"
            onClick={() => router.push("/agents")}
          >
            ← Retour aux agents
          </button>
          <div className="agentMeta">
            <div className="agentName">{agent?.name || agentSlug}</div>
            <div className="agentRole mutedSmall">{agent?.role || ""}</div>
          </div>
        </div>
        <div className="actions">
          <div className="userEmail mutedSmall">{user?.email || ""}</div>
          <button className="btn logout" type="button" onClick={logout}>
            Déconnexion
          </button>
        </div>
      </div>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebarTop">
            <div className="sidebarTitle">Historique</div>
            <button
              className="btn new"
              type="button"
              onClick={createConversation}
              disabled={creatingConv}
            >
              + Nouvelle
            </button>
          </div>

          {loadingConvs ? (
            <div className="muted">Chargement…</div>
          ) : (
            <div className="convList">
              {conversations.map((c) => {
                const active = c.id === selectedConversationId;
                return (
                  <button
                    key={c.id}
                    className={`convItem ${active ? "active" : ""}`}
                    type="button"
                    onClick={() => selectConversation(c.id)}
                  >
                    <div className="convTitle">
                      {c.title || "Conversation"}
                    </div>
                    <div className="convDate mutedSmall">
                      {new Date(c.created_at).toLocaleString()}
                    </div>
                  </button>
                );
              })}
              {conversations.length === 0 && (
                <div className="muted">Aucune conversation</div>
              )}
            </div>
          )}
        </aside>

        <main className="main">
          <div className="chat">
            <div className="chatBody">
              {loadingMsgs ? (
                <div className="muted">Chargement…</div>
              ) : (
                <>
                  {messages.map((m, idx) => (
                    <div
                      key={m.id || idx}
                      className={`msgRow ${m.role === "user" ? "me" : "ai"}`}
                    >
                      {m.role !== "user" && (
                        <div className="avatar">
                          {agent?.avatar_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={agent.avatar_url} alt="avatar" />
                          ) : (
                            <div className="avatarFallback">
                              {(agent?.name || "A")[0]}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="bubble">
                        <div className="bubbleText">{m.content}</div>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            {err && <div className="error">{err}</div>}

            <div className="chatFooter">
              <textarea
                className="input"
                placeholder="Écrire…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
              />

              {/* Micro: icône SVG propre (design) - le click reste un placeholder */}
              <button
                className="btn mic"
                type="button"
                aria-label="Dictée vocale"
                title="Dictée vocale"
                onClick={() =>
                  alert(
                    "Dictée vocale: à connecter à ton modèle (SpeechRecognition)"
                  )
                }
              >
                <svg
                  className="micIcon"
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M19 11a7 7 0 0 1-14 0"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 18v3"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M8 21h8"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              <button
                className="btn send"
                type="button"
                onClick={sendMessage}
                disabled={sending}
              >
                Envoyer
              </button>
            </div>
          </div>
        </main>
      </div>

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

        .brand {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .agentMeta {
          display: flex;
          flex-direction: column;
          line-height: 1.1;
        }

        .agentName {
          font-weight: 800;
        }

        .actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .layout {
          display: grid;
          grid-template-columns: 320px 1fr;
          min-height: calc(100vh - 64px);
        }

        .sidebar {
          border-right: 1px solid rgba(255, 255, 255, 0.06);
          padding: 14px;
          background: rgba(255, 255, 255, 0.02);
        }

        .sidebarTop {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 12px;
        }

        .sidebarTitle {
          font-weight: 800;
        }

        .convList {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .convItem {
          text-align: left;
          border-radius: 14px;
          padding: 10px 12px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.02);
          color: inherit;
          cursor: pointer;
        }

        .convItem.active {
          border-color: rgba(255, 130, 30, 0.45);
          background: rgba(255, 130, 30, 0.08);
        }

        .convTitle {
          font-weight: 700;
        }

        .main {
          padding: 14px;
        }

        .chat {
          height: calc(100vh - 64px - 28px);
          display: flex;
          flex-direction: column;
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.06);
          background: rgba(255, 255, 255, 0.02);
          overflow: hidden;
        }

        .chatBody {
          flex: 1;
          overflow: auto;
          padding: 16px;
        }

        .msgRow {
          display: flex;
          gap: 10px;
          margin-bottom: 12px;
          align-items: flex-start;
        }

        .msgRow.me {
          justify-content: flex-end;
        }

        .avatar {
          width: 40px;
          height: 40px;
          border-radius: 14px;
          overflow: hidden;
          flex: 0 0 auto;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.04);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .avatarFallback {
          font-weight: 900;
          color: rgba(255, 130, 30, 0.95);
        }

        .bubble {
          max-width: 760px;
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(0, 0, 0, 0.25);
          padding: 12px 14px;
          line-height: 1.45;
        }

        .msgRow.me .bubble {
          border-color: rgba(255, 130, 30, 0.35);
          background: rgba(255, 130, 30, 0.12);
        }

        .bubbleText {
          white-space: pre-wrap;
        }

        .error {
          background: rgba(180, 20, 20, 0.35);
          border-top: 1px solid rgba(180, 20, 20, 0.55);
          color: #ffdede;
          padding: 10px 14px;
          font-weight: 700;
        }

        .chatFooter {
          display: grid;
          grid-template-columns: 1fr auto auto;
          gap: 10px;
          align-items: center;
          padding: 10px 14px 14px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          background: rgba(0, 0, 0, 0.25);
        }

        .input {
          height: 48px;
          resize: none;
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(0, 0, 0, 0.25);
          color: #e9eef6;
          padding: 12px 14px;
          outline: none;
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

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .btn.logout {
          border-color: rgba(255, 80, 80, 0.35);
        }

        .btn.back {
          border-color: rgba(255, 130, 30, 0.22);
          background: rgba(255, 130, 30, 0.08);
        }

        .btn.new {
          border-color: rgba(255, 130, 30, 0.22);
          background: rgba(255, 130, 30, 0.08);
        }

        .btn.send {
          border-color: rgba(255, 130, 30, 0.35);
          background: rgba(255, 130, 30, 0.12);
        }

        .btn.mic {
          width: 48px;
          height: 48px;
          padding: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(255, 255, 255, 0.04);
        }

        .btn.mic:hover {
          border-color: rgba(255, 130, 30, 0.45);
          background: rgba(255, 130, 30, 0.10);
        }

        .btn.mic:active {
          transform: translateY(1px);
        }

        .micIcon {
          width: 20px;
          height: 20px;
          opacity: 0.92;
        }

        .muted {
          color: rgba(233, 238, 246, 0.65);
          font-size: 14px;
          padding: 8px;
        }

        .mutedSmall {
          color: rgba(233, 238, 246, 0.55);
          font-size: 12px;
        }

        @media (max-width: 920px) {
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
