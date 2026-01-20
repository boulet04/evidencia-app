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
  return "Salut ! 😊 Comment puis-je t’aider aujourd’hui ?";
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

  // Voice (Web Speech API)
  const recognitionRef = useRef(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

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

  // Init speech recognition
  useEffect(() => {
    if (typeof window === "undefined") return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setVoiceSupported(false);
      return;
    }

    setVoiceSupported(true);

    const rec = new SR();
    rec.lang = "fr-FR";
    rec.interimResults = true;
    rec.continuous = false;

    rec.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0]?.transcript || "";
      }
      transcript = transcript.trim();
      if (transcript) {
        setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
      }
    };

    rec.onend = () => {
      setIsRecording(false);
    };

    rec.onerror = () => {
      setIsRecording(false);
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

      // welcome assistant message
      const welcomeText = defaultWelcome();

      await supabase.from("messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: welcomeText,
      });

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

      // Insert user message
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

      // Call API
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

      const data = await resp.json();
      const assistantText = (data?.reply || data?.content || "").trim();

      if (assistantText) {
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

  function toggleMic() {
    if (!voiceSupported || !recognitionRef.current) return;

    try {
      if (isRecording) {
        recognitionRef.current.stop();
        setIsRecording(false);
      } else {
        setIsRecording(true);
        recognitionRef.current.start();
      }
    } catch {
      setIsRecording(false);
    }
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

              <button
                className={`btn mic ${isRecording ? "recording" : ""}`}
                type="button"
                title={voiceSupported ? (isRecording ? "Arrêter la dictée" : "Dictée vocale") : "Dictée vocale non supportée"}
                onClick={toggleMic}
                disabled={!voiceSupported || !selectedConversationId || sending}
              >
                {/* true mic icon (SVG) */}
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
                  />
                </svg>
              </button>

              <button className="btn send" onClick={handleSend} disabled={!selectedConversationId || sending}>
                {sending ? "Envoi..." : "Envoyer"}
              </button>
            </div>

            <div className="chatFooter">
              <div className="mutedSmall">{selectedConversation ? `Conversation: ${selectedConversation.id}` : ""}</div>
            </div>
          </div>
        </main>
      </div>

      <style jsx>{`
        .page {
          min-height: 100vh;
          background: var(--e-bg, #050608);
          color: var(--e-text, #e9eef6);
        }

        .topbar {
          height: 64px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          border-bottom: 1px solid var(--e-border, rgba(255, 255, 255, 0.06));
          background: radial-gradient(1200px 220px at 50% -20%, rgba(255, 122, 0, 0.22), transparent);
        }

        .btn {
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.04);
          color: var(--e-text, #e9eef6);
          padding: 10px 12px;
          border-radius: 14px;
          cursor: pointer;
          font-weight: 700;
        }

        .btn:disabled {
          opacity: 0.55;
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
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.02);
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
          color: rgba(233, 238, 246, 0.65);
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

        /* orange plus vif */
        .convItem.active {
          border-color: rgba(255, 122, 0, 0.6);
          background: rgba(255, 122, 0, 0.14);
          box-shadow: 0 0 0 1px rgba(255, 122, 0, 0.18) inset;
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

        .main {
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.02);
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

        /* IMPORTANT: recadrage tête */
        .agentAvatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center 18%;
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
          color: rgba(233, 238, 246, 0.65);
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

        /* orange plus vif sur la bulle user */
        .msgRow.user .msgBubble {
          border-color: rgba(255, 122, 0, 0.55);
          background: rgba(255, 122, 0, 0.16);
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
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(0, 0, 0, 0.25);
          color: #e9eef6;
          padding: 0 14px;
          outline: none;
        }

        .btn.send {
          border-color: rgba(255, 122, 0, 0.7);
          background: rgba(255, 122, 0, 0.22);
        }

        .btn.mic {
          width: 48px;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-color: rgba(255, 122, 0, 0.35);
        }

        .btn.mic.recording {
          border-color: rgba(255, 122, 0, 0.9);
          background: rgba(255, 122, 0, 0.28);
          box-shadow: 0 0 0 1px rgba(255, 122, 0, 0.25) inset;
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
