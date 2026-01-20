// pages/chat/[agentSlug].js
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

function defaultWelcome() {
  return "Bonjour, comment puis-je vous aider?";
}

function MicIcon({ size = 18 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0a1 1 0 1 0-2 0a7 7 0 0 0 6 6.93V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.07A7 7 0 0 0 19 11a1 1 0 1 0-2 0Z"
      />
    </svg>
  );
}

function StopIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7 7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V7Z"
      />
    </svg>
  );
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

  // Voice dictation
  const [speechSupported, setSpeechSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const recognitionRef = useRef(null);

  const messagesEndRef = useRef(null);

  const accessToken = useMemo(() => session?.access_token || null, [session]);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session || null);
      setUser(data.session?.user || null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession || null);
      setUser(newSession?.user || null);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  // Init speech recognition (browser)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setSpeechSupported(false);
      return;
    }

    setSpeechSupported(true);

    const rec = new SR();
    rec.lang = "fr-FR";
    rec.interimResults = true;
    rec.continuous = true;

    rec.onresult = (event) => {
      let interim = "";
      let finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) finalText += transcript;
        else interim += transcript;
      }

      // On ajoute au champ sans écraser ce que tu as déjà tapé
      setInput((prev) => {
        const base = prev.trim().length ? prev.trim() + " " : "";
        const merged = (base + finalText + interim).replace(/\s+/g, " ").trimStart();
        return merged;
      });
    };

    rec.onerror = () => {
      setRecording(false);
    };

    rec.onend = () => {
      setRecording(false);
    };

    recognitionRef.current = rec;

    return () => {
      try {
        rec.stop();
      } catch {}
      recognitionRef.current = null;
    };
  }, []);

  function toggleDictation() {
    if (!speechSupported) {
      alert("Dictée vocale non supportée sur ce navigateur.");
      return;
    }
    const rec = recognitionRef.current;
    if (!rec) return;

    if (!recording) {
      try {
        rec.start();
        setRecording(true);
      } catch {
        // start() peut throw si déjà démarré
        setRecording(true);
      }
    } else {
      try {
        rec.stop();
      } catch {}
      setRecording(false);
    }
  }

  // Load agent meta
  useEffect(() => {
    if (!agentSlug || typeof agentSlug !== "string") return;

    (async () => {
      const { data, error } = await supabase
        .from("agents")
        .select("id,slug,name,description,avatar_url")
        .eq("slug", agentSlug)
        .maybeSingle();

      if (!error) setAgent(data || null);
    })();
  }, [agentSlug]);

  // Load conversations for this user + agent
  useEffect(() => {
    if (!user?.id) return;
    if (!agentSlug || typeof agentSlug !== "string") return;

    (async () => {
      setLoadingConvs(true);
      const { data, error } = await supabase
        .from("conversations")
        .select("id,title,created_at,agent_slug")
        .eq("user_id", user.id)
        .eq("agent_slug", agentSlug)
        .order("created_at", { ascending: false });

      setLoadingConvs(false);

      if (error) return;

      const list = data || [];
      setConversations(list);

      if (!selectedConversationId && list.length > 0) {
        setSelectedConversationId(list[0].id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, agentSlug]);

  // Load messages for selected conversation
  async function reloadMessages(conversationId) {
    if (!conversationId) {
      setMessages([]);
      return;
    }

    setLoadingMsgs(true);
    const { data, error } = await supabase
      .from("messages")
      .select("id,role,content,created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    setLoadingMsgs(false);
    if (error) return;

    setMessages(data || []);
  }

  useEffect(() => {
    reloadMessages(selectedConversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      const { data: conv, error: convErr } = await supabase
        .from("conversations")
        .insert({
          user_id: user.id,
          agent_slug: agentSlug,
          title,
          archived: false,
        })
        .select("id,title,created_at,agent_slug")
        .single();

      if (convErr) throw convErr;

      // Welcome msg (client-side insert OK)
      const { error: msgErr } = await supabase.from("messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: defaultWelcome(),
      });

      if (msgErr) console.warn("Welcome message insert failed:", msgErr.message);

      setConversations((prev) => [conv, ...prev]);
      setSelectedConversationId(conv.id);
      await reloadMessages(conv.id);
    } catch (e) {
      console.error(e);
      alert("Impossible de créer une nouvelle conversation.");
    } finally {
      setCreatingConv(false);
    }
  }

  async function handleDeleteConversation(conversationId) {
    if (!accessToken) {
      alert("Session invalide. Veuillez vous reconnecter.");
      return;
    }

    const ok = confirm("Supprimer cette conversation ? Cette action est irréversible.");
    if (!ok) return;

    try {
      const resp = await fetch(`/api/conversations/${conversationId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!resp.ok && resp.status !== 204) {
        const j = await resp.json().catch(() => null);
        throw new Error(j?.error || "Delete failed");
      }

      setConversations((prev) => prev.filter((c) => c.id !== conversationId));

      if (selectedConversationId === conversationId) {
        const remaining = conversations.filter((c) => c.id !== conversationId);
        setSelectedConversationId(remaining[0]?.id || null);
      }
    } catch (e) {
      console.error(e);
      alert("Impossible de supprimer la conversation.");
    }
  }

  async function handleSend() {
    if (!selectedConversationId) return;
    const content = input.trim();
    if (!content) return;

    try {
      setSending(true);
      setInput("");

      // IMPORTANT: on ne double-insert pas côté client.
      // L’API /api/chat insère user+assistant en DB.
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          conversation_id: selectedConversationId,
          agent_slug: agentSlug,
          message: content,
        }),
      });

      if (!resp.ok) {
        const j = await resp.json().catch(() => null);
        throw new Error(j?.error || "Chat API error");
      }

      // reload messages from DB (source de vérité)
      await reloadMessages(selectedConversationId);
    } catch (e) {
      console.error(e);
      alert("Erreur lors de l’envoi du message.");
    } finally {
      setSending(false);
    }
  }

  function handleSelectConversation(id) {
    setSelectedConversationId(id);
  }

  const selectedConversation = useMemo(() => {
    return conversations.find((c) => c.id === selectedConversationId) || null;
  }, [conversations, selectedConversationId]);

  const showWelcomeFallback =
    !loadingMsgs && selectedConversationId && (messages?.length || 0) === 0;

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
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sidebarHeader">
            <div className="sidebarTitle">Historique</div>
            <button className="btn new" onClick={handleNewConversation} disabled={creatingConv}>
              + Nouvelle
            </button>
          </div>

          <div className="sidebarBody">
            {loadingConvs ? (
              <div className="muted">Chargement...</div>
            ) : conversations.length === 0 ? (
              <div className="muted">Aucune conversation.</div>
            ) : (
              <div className="convList">
                {conversations.map((c) => {
                  const active = c.id === selectedConversationId;
                  return (
                    <div
                      key={c.id}
                      className={`convItem ${active ? "active" : ""}`}
                      onClick={() => handleSelectConversation(c.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="convTitle" title={c.title || ""}>
                        {c.title || "Conversation"}
                      </div>

                      <button
                        className="convDelete"
                        title="Supprimer la conversation"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteConversation(c.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        {/* Main */}
        <main className="main">
          <div className="agentHeader">
            <div className="agentLeft">
              <div className="agentAvatar">
                {agent?.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={agent.avatar_url} alt={agent.name || "Agent"} />
                ) : (
                  <div className="avatarFallback">{(agent?.name || "A").slice(0, 1)}</div>
                )}
              </div>
              <div className="agentMeta">
                <div className="agentName">{agent?.name || "Agent"}</div>
                <div className="agentRole">{agent?.description || ""}</div>
              </div>
            </div>
          </div>

          <div className="chat">
            <div className="chatBody">
              {!selectedConversationId ? (
                <div className="muted">Sélectionne une conversation ou clique sur “+ Nouvelle”.</div>
              ) : loadingMsgs ? (
                <div className="muted">Chargement des messages...</div>
              ) : (
                <>
                  {showWelcomeFallback && (
                    <div className="msgRow assistant">
                      <div className="msgBubble">{defaultWelcome()}</div>
                    </div>
                  )}

                  {(messages || []).map((m) => (
                    <div key={m.id} className={`msgRow ${m.role === "user" ? "user" : "assistant"}`}>
                      <div className="msgBubble">{m.content}</div>
                    </div>
                  ))}

                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

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

              <button
                className={`btn mic ${recording ? "recording" : ""}`}
                type="button"
                title={recording ? "Arrêter la dictée" : "Dictée vocale"}
                onClick={toggleDictation}
                disabled={!selectedConversationId || sending}
              >
                {recording ? <StopIcon /> : <MicIcon />}
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
              {!speechSupported && (
                <div className="mutedSmall">
                  Dictée vocale: non supportée sur ce navigateur.
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      <style jsx>{`
        .page {
          min-height: 100vh;
          background: var(--evi-bg);
          color: var(--evi-text);
        }

        .topbar {
          height: 64px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          background: var(--evi-topbar-glow);
        }

        .btn {
          border: 1px solid var(--evi-border-strong);
          background: rgba(255, 255, 255, 0.04);
          color: var(--evi-text);
          padding: 10px 12px;
          border-radius: var(--evi-radius-sm);
          cursor: pointer;
          font-weight: 700;
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .btn.logout {
          border-color: var(--evi-danger-border);
          background: var(--evi-danger-weak);
        }

        .brand {
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 1;
          text-align: center;
        }

        .brandTitle {
          font-size: 20px;
          font-weight: 900;
          letter-spacing: 0.6px;
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

        .layout {
          display: grid;
          grid-template-columns: 340px 1fr;
          gap: 16px;
          padding: 16px;
        }

        .sidebar {
          border: 1px solid var(--evi-border);
          border-radius: var(--evi-radius-lg);
          background: var(--evi-panel);
          overflow: hidden;
          min-height: calc(100vh - 96px);
        }

        .sidebarHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 14px 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }

        .sidebarTitle {
          font-size: 16px;
          font-weight: 900;
        }

        .sidebarBody {
          padding: 10px;
        }

        .muted {
          color: var(--evi-muted);
          font-size: 14px;
          padding: 8px;
        }

        .mutedSmall {
          color: rgba(233, 238, 246, 0.55);
          font-size: 12px;
        }

        .convList {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .convItem {
          position: relative;
          border: 1px solid var(--evi-border);
          border-radius: var(--evi-radius-md);
          padding: 12px 44px 12px 12px;
          background: var(--evi-panel-2);
          cursor: pointer;
          transition: border-color 0.15s ease, background 0.15s ease;
        }

        .convItem:hover {
          border-color: rgba(255, 255, 255, 0.16);
          background: rgba(255, 255, 255, 0.04);
        }

        /* ORANGE + VIF sur la conversation active */
        .convItem.active {
          border-color: var(--evi-accent-border);
          background: var(--evi-accent-weak-2);
        }

        .convTitle {
          font-weight: 800;
          font-size: 14px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .convDelete {
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
          width: 30px;
          height: 30px;
          border-radius: 12px;
          border: 1px solid var(--evi-danger-border);
          background: var(--evi-danger-weak);
          color: rgba(255, 210, 210, 0.95);
          font-size: 20px;
          line-height: 28px;
          cursor: pointer;
        }

        .convDelete:hover {
          background: rgba(255, 59, 59, 0.18);
        }

        .main {
          border: 1px solid var(--evi-border);
          border-radius: var(--evi-radius-lg);
          background: var(--evi-panel);
          min-height: calc(100vh - 96px);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .agentHeader {
          padding: 14px 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .agentLeft {
          display: flex;
          gap: 12px;
          align-items: center;
        }

        .agentAvatar {
          width: 44px;
          height: 44px;
          border-radius: var(--evi-radius-md);
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.04);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        /* RECADRAGE: on “remonte” le point d’intérêt -> on voit mieux la tête */
        .agentAvatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center 10%;
        }

        .avatarFallback {
          font-weight: 900;
          opacity: 0.85;
        }

        .agentName {
          font-weight: 900;
        }

        .agentRole {
          font-size: 12px;
          color: var(--evi-muted);
          margin-top: 2px;
        }

        .chat {
          display: flex;
          flex-direction: column;
          flex: 1;
        }

        .chatBody {
          flex: 1;
          padding: 16px;
          overflow: auto;
        }

        .msgRow {
          display: flex;
          margin-bottom: 10px;
        }

        .msgRow.user {
          justify-content: flex-end;
        }

        .msgRow.assistant {
          justify-content: flex-start;
        }

        .msgBubble {
          max-width: 820px;
          border: 1px solid var(--evi-border);
          background: var(--evi-panel-2);
          border-radius: 18px;
          padding: 12px 14px;
          font-size: 14px;
          line-height: 1.5;
          white-space: pre-wrap;
        }

        /* ORANGE + VIF sur les bulles user */
        .msgRow.user .msgBubble {
          border-color: var(--evi-accent-border);
          background: var(--evi-accent-weak);
        }

        .chatInput {
          display: flex;
          gap: 10px;
          padding: 14px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          align-items: center;
        }

        .input {
          flex: 1;
          height: 48px;
          border-radius: var(--evi-radius-md);
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: var(--evi-input-bg);
          color: var(--evi-text);
          padding: 0 14px;
          outline: none;
        }

        /* ORANGE + VIF sur Envoyer */
        .btn.send {
          border-color: var(--evi-accent-border);
          background: var(--evi-accent);
          color: #0b0b0b;
          font-weight: 900;
        }

        .btn.send:hover {
          filter: brightness(1.04);
        }

        .btn.mic {
          width: 48px;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: var(--evi-radius-md);
          border-color: rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.04);
        }

        .btn.mic.recording {
          border-color: var(--evi-accent-border);
          background: var(--evi-accent-weak);
          color: var(--evi-accent);
        }

        .chatFooter {
          padding: 10px 14px 14px;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }

        @media (max-width: 980px) {
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
