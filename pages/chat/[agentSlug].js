// pages/chat/[agentSlug].js
import Head from "next/head";
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
  return "Bonjour, comment puis-je vous aider ?";
}

function MicIcon({ size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
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
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
  const finalTranscriptRef = useRef("");

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

  // Init SpeechRecognition (Chrome/Edge)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      recognitionRef.current = null;
      return;
    }

    const rec = new SR();
    rec.lang = "fr-FR";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) {
          finalTranscriptRef.current += t;
        } else {
          interim += t;
        }
      }
      const combined = (finalTranscriptRef.current + " " + interim).trim();
      setInput(combined);
    };

    rec.onerror = () => {
      setIsListening(false);
    };

    rec.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = rec;
  }, []);

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
      if (error) return;

      setMessages(data || []);
    })();
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

      const welcomeText = defaultWelcome();

      const { error: msgErr } = await supabase.from("messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: welcomeText,
      });

      if (msgErr) {
        console.warn("Welcome message insert failed:", msgErr.message);
      }

      setConversations((prev) => [conv, ...prev]);
      setSelectedConversationId(conv.id);
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
        headers: { Authorization: `Bearer ${accessToken}` },
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

      // Insert user message (client-side)
      const { data: userMsg, error: userMsgErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: selectedConversationId,
          role: "user",
          content,
        })
        .select("id,role,content,created_at")
        .single();

      if (userMsgErr) throw userMsgErr;
      setMessages((prev) => [...prev, userMsg]);

      // Call API (server will include prompt général + prompt agent)
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          // send both naming styles to be safe
          conversationId: selectedConversationId,
          conversation_id: selectedConversationId,
          agentSlug: agentSlug,
          agent_slug: agentSlug,
          message: content,
        }),
      });

      if (!resp.ok) {
        const j = await resp.json().catch(() => null);
        throw new Error(j?.error || "Chat API error");
      }

      const data = await resp.json();
      const assistantText = data?.reply || data?.content || "";

      if (assistantText) {
        // Insert assistant message (client-side)
        const { data: asstMsg, error: asstErr } = await supabase
          .from("messages")
          .insert({
            conversation_id: selectedConversationId,
            role: "assistant",
            content: assistantText,
          })
          .select("id,role,content,created_at")
          .single();

        if (!asstErr && asstMsg) {
          setMessages((prev) => [...prev, asstMsg]);
        }
      }
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

  function toggleDictation() {
    const rec = recognitionRef.current;
    if (!rec) {
      alert("Dictée vocale indisponible sur ce navigateur (SpeechRecognition). Utilise Chrome/Edge.");
      return;
    }

    if (isListening) {
      try {
        rec.stop();
      } catch {}
      setIsListening(false);
      return;
    }

    finalTranscriptRef.current = input ? input + " " : "";
    try {
      rec.start();
      setIsListening(true);
    } catch {
      setIsListening(false);
    }
  }

  const selectedConversation = useMemo(() => {
    return conversations.find((c) => c.id === selectedConversationId) || null;
  }, [conversations, selectedConversationId]);

  const showWelcomeFallback =
    !loadingMsgs && selectedConversationId && (messages?.length || 0) === 0;

  return (
    <div className="page">
      <Head>
        <link rel="stylesheet" href="/brand.css" />
      </Head>

      <div className="topbar">
        <button className="btn back" onClick={() => router.push("/agents")}>
          ← Retour aux agents
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

              {/* Bouton micro (SVG) entre input et envoyer */}
              <button
                className={`btn mic ${isListening ? "listening" : ""}`}
                type="button"
                title={isListening ? "Arrêter la dictée" : "Dicter un message"}
                aria-pressed={isListening}
                onClick={toggleDictation}
                disabled={!selectedConversationId || sending}
              >
                <MicIcon size={20} />
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

      <style jsx>{`
        .page {
          min-height: 100vh;
          background: var(--evi-bg-0);
          color: var(--evi-text);
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
            rgba(255, 122, 0, 0.18),
            transparent
          );
        }

        .btn {
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.04);
          color: var(--evi-text);
          padding: 10px 12px;
          border-radius: 14px;
          cursor: pointer;
          font-weight: 700;
        }

        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .btn.logout {
          border-color: rgba(255, 80, 80, 0.35);
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
          border-radius: 18px;
          background: var(--evi-bg-1);
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
          color: var(--evi-text-muted);
          font-size: 14px;
          padding: 8px;
        }

        .mutedSmall {
          color: var(--evi-text-muted-2);
          font-size: 12px;
        }

        .convList {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .convItem {
          position: relative;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          padding: 12px 44px 12px 12px;
          background: rgba(255, 255, 255, 0.03);
          cursor: pointer;
          transition: border-color 0.15s ease, background 0.15s ease;
        }

        .convItem:hover {
          border-color: rgba(255, 255, 255, 0.16);
          background: rgba(255, 255, 255, 0.04);
        }

        /* ORANGE PLUS VIF */
        .convItem.active {
          border-color: var(--evi-accent-2);
          background: rgba(255, 122, 0, 0.10);
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
          border: 1px solid rgba(255, 60, 60, 0.35);
          background: rgba(255, 60, 60, 0.12);
          color: rgba(255, 210, 210, 0.95);
          font-size: 20px;
          line-height: 28px;
          cursor: pointer;
        }

        .convDelete:hover {
          background: rgba(255, 60, 60, 0.18);
          border-color: rgba(255, 60, 60, 0.55);
        }

        .main {
          border: 1px solid var(--evi-border);
          border-radius: 18px;
          background: var(--evi-bg-1);
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
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.04);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        /* RECADRAGE (tête visible) */
        .agentAvatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center 20%;
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
          color: var(--evi-text-muted);
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
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.03);
          border-radius: 18px;
          padding: 12px 14px;
          font-size: 14px;
          line-height: 1.5;
          white-space: pre-wrap;
        }

        /* ORANGE PLUS VIF pour bulles user */
        .msgRow.user .msgBubble {
          border-color: var(--evi-accent-2);
          background: var(--evi-accent-bubble);
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
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(0, 0, 0, 0.25);
          color: var(--evi-text);
          padding: 0 14px;
          outline: none;
        }

        .input:focus {
          box-shadow: var(--evi-focus);
          border-color: rgba(255, 122, 0, 0.30);
        }

        /* ORANGE PLUS VIF bouton envoyer */
        .btn.send {
          border-color: var(--evi-accent-2);
          background: var(--evi-accent-bg);
        }

        .btn.send:hover:not(:disabled) {
          background: rgba(255, 122, 0, 0.18);
        }

        .btn.mic {
          width: 48px;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
        }

        .btn.mic.listening {
          border-color: var(--evi-accent-2);
          background: rgba(255, 122, 0, 0.18);
        }

        .chatFooter {
          padding: 10px 14px 14px;
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
