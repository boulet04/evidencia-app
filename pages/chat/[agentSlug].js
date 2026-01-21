-vimport { useEffect, useMemo, useRef, useState } from "react";
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
  if (!agentName) return "Bonjour ! Comment puis-je vous aider aujourd'hui ?";
  return `Bonjour Simon,\n\nComment puis-je vous aider aujourd'hui ?`;
}

export default function AgentChatPage() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const [user, setUser] = useState(null);

  const [agent, setAgent] = useState(null);
  const [agentError, setAgentError] = useState("");

  const [conversations, setConversations] = useState([]);
  const [loadingConvos, setLoadingConvos] = useState(true);

  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [messages, setMessages] = useState([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [apiError, setApiError] = useState("");

  const messagesEndRef = useRef(null);

  // --- Micro (dictée vocale) ---
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  // Auth session
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data?.session;
      if (!session?.user) {
        router.push("/login");
        return;
      }
      setUser(session.user);
    })();
  }, [router]);

  // Load agent by slug
  useEffect(() => {
    if (!agentSlug) return;
    (async () => {
      setAgentError("");
      const { data, error } = await supabase
        .from("agents")
        .select("id,slug,name,role,avatar_url,system_prompt,description")
        .eq("slug", agentSlug)
        .single();

      if (error) {
        console.error(error);
        setAgentError("Impossible de charger cet agent.");
        setAgent(null);
        return;
      }
      setAgent(data);
    })();
  }, [agentSlug]);

  // Load conversations list for this user + this agent
  useEffect(() => {
    if (!user?.id || !agentSlug) return;

    (async () => {
      setLoadingConvos(true);
      setApiError("");

      // IMPORTANT:
      // ton schéma n’a PAS conversations.agent_id -> on filtre via conversations.agent_slug
      const { data, error } = await supabase
        .from("conversations")
        .select("id,title,created_at,agent_slug")
        .eq("user_id", user.id)
        .eq("agent_slug", agentSlug)
        .order("created_at", { ascending: false });

      if (error) {
        console.error(error);
        setApiError(error.message || "Erreur chargement conversations");
        setConversations([]);
        setSelectedConversationId("");
        setLoadingConvos(false);
        return;
      }

      const rows = data || [];
      setConversations(rows);

      // auto-select latest
      if (rows.length > 0) {
        setSelectedConversationId(rows[0].id);
      } else {
        setSelectedConversationId("");
      }

      setLoadingConvos(false);
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

      if (error) {
        console.error(error);
        setApiError(error.message || "Erreur chargement messages");
        setMessages([]);
        setLoadingMsgs(false);
        return;
      }

      setMessages(data || []);
      setLoadingMsgs(false);
    })();
  }, [selectedConversationId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length]);

  // Init SpeechRecognition once (client-side only)
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
    rec.continuous = false;

    rec.onresult = (event) => {
      let txt = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        txt += event.results[i][0]?.transcript || "";
      }
      // On ajoute au texte existant (sans écraser)
      setInput((prev) => (prev ? (prev + " " + txt).trim() : String(txt).trim()));
    };

    rec.onerror = () => {
      setIsRecording(false);
    };

    rec.onend = () => {
      setIsRecording(false);
      // refocus input après dictée
      setTimeout(() => inputRef.current?.focus(), 0);
    };

    recognitionRef.current = rec;
    return () => {
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.stop();
      } catch (e) {}
      recognitionRef.current = null;
    };
  }, []);

  function toggleDictation() {
    if (!speechSupported || !recognitionRef.current) {
      alert("Dictée vocale non supportée sur ce navigateur.");
      return;
    }
    try {
      if (isRecording) {
        recognitionRef.current.stop();
        setIsRecording(false);
        return;
      }
      setIsRecording(true);
      recognitionRef.current.start();
    } catch (e) {
      setIsRecording(false);
    }
  }

  async function createConversation() {
    if (!user?.id || !agentSlug) return;

    setApiError("");
    try {
      const title = formatTitleFallback(agent?.name);

      const { data, error } = await supabase
        .from("conversations")
        .insert([
          {
            user_id: user.id,
            title,
            agent_slug: agentSlug,
          },
        ])
        .select("id,title,created_at,agent_slug")
        .single();

      if (error) throw error;

      const newRow = data;
      setConversations((prev) => [newRow, ...(prev || [])]);
      setSelectedConversationId(newRow.id);
      setMessages([]);
      setInput("");
      // focus direct dans le champ à la création
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (e) {
      console.error(e);
      setApiError(e.message || "Erreur création conversation");
    }
  }

  async function deleteConversation(id) {
    if (!id) return;
    setApiError("");

    try {
      const { error } = await supabase.from("conversations").delete().eq("id", id);
      if (error) throw error;

      setConversations((prev) => (prev || []).filter((c) => c.id !== id));

      if (selectedConversationId === id) {
        setSelectedConversationId("");
        setMessages([]);
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
      setApiError("");

      // Insert user message
      const { data: insertedUserMsg, error: insUserErr } = await supabase
        .from("messages")
        .insert([
          {
            conversation_id: selectedConversationId,
            role: "user",
            content,
          },
        ])
        .select("id,role,content,created_at")
        .single();

      if (insUserErr) throw insUserErr;

      setMessages((prev) => [...(prev || []), insertedUserMsg]);

      // Call API
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: selectedConversationId,
          agentSlug,
          message: content,
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || `Erreur API (${res.status})`);
      }

      const reply = String(json?.reply || "").trim();

      // Insert assistant message
      const { data: insertedAsstMsg, error: insAsstErr } = await supabase
        .from("messages")
        .insert([
          {
            conversation_id: selectedConversationId,
            role: "assistant",
            content: reply,
          },
        ])
        .select("id,role,content,created_at")
        .single();

      if (insAsstErr) throw insAsstErr;

      setMessages((prev) => [...(prev || []), insertedAsstMsg]);

      // refocus input après envoi
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (e) {
      console.error(e);
      setApiError(e.message || "Erreur interne API");
      // refocus même si erreur
      setTimeout(() => inputRef.current?.focus(), 0);
    } finally {
      setSending(false);
    }
  }

  function handleSelectConversation(id) {
    setSelectedConversationId(id);
    // focus dès qu’on ouvre une conversation
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  const selectedConversation = useMemo(() => {
    return conversations.find((c) => c.id === selectedConversationId) || null;
  }, [conversations, selectedConversationId]);

  const showWelcomeFallback =
    !loadingMsgs && selectedConversationId && (messages?.length || 0) === 0;

  return (
    <div className="page">
      <div className="topbar">
        <button className="ghost" onClick={() => router.push("/agents")}>
          ← Retour aux agents
        </button>
        <div className="topbarTitle">
          <div className="agentName">{agent?.name || "Agent"}</div>
          <div className="agentRole">{agent?.role || ""}</div>
        </div>
        <button className="primary" onClick={createConversation}>
          + Nouvelle
        </button>
      </div>

      <div className="layout">
        {/* Sidebar conversations */}
        <aside className="sidebar">
          <div className="sidebarHeader">Historique</div>

          {loadingConvos ? (
            <div className="muted">Chargement…</div>
          ) : (
            <div className="convoList">
              {(conversations || []).map((c) => (
                <div
                  key={c.id}
                  className={`convoItem ${
                    c.id === selectedConversationId ? "active" : ""
                  }`}
                  onClick={() => handleSelectConversation(c.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="convoTitle">{c.title || "Conversation"}</div>
                  <div className="convoMeta">
                    {c.created_at ? new Date(c.created_at).toLocaleString() : ""}
                  </div>
                  <button
                    className="deleteBtn"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(c.id);
                    }}
                    title="Supprimer"
                  >
                    ×
                  </button>
                </div>
              ))}
              {(conversations || []).length === 0 && (
                <div className="muted">Aucune conversation.</div>
              )}
            </div>
          )}
        </aside>

        {/* Main chat */}
        <main className="main">
          <div className="chatCard">
            {!!agentError && <div className="error">{agentError}</div>}
            {!!apiError && <div className="error">{apiError}</div>}

            <div className="chatHeader">
              <div className="chatHeaderLeft">
                <div className="avatar">
                  {agent?.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={agent.avatar_url} alt="avatar" />
                  ) : (
                    <div className="avatarFallback">🙂</div>
                  )}
                </div>
                <div>
                  <div className="hTitle">{agent?.name || "Agent"}</div>
                  <div className="hSub">{agent?.role || ""}</div>
                </div>
              </div>
              <div className="chatHeaderRight">
                <button
                  className="ghost"
                  onClick={async () => {
                    await supabase.auth.signOut();
                    router.push("/login");
                  }}
                >
                  Déconnexion
                </button>
              </div>
            </div>

            <div className="chatBody">
              {!selectedConversationId ? (
                <div className="muted">
                  Sélectionne une conversation ou clique sur “Nouvelle”.
                </div>
              ) : loadingMsgs ? (
                <div className="muted">Chargement…</div>
              ) : showWelcomeFallback ? (
                <div className="msgRow assistant">
                  <div className="msgBubble assistant">
                    {defaultWelcome(agent?.name)}
                  </div>
                  <div ref={messagesEndRef} />
                </div>
              ) : (
                <>
                  {(messages || []).map((m) => (
                    <div key={m.id} className={`msgRow ${m.role}`}>
                      <div className={`msgBubble ${m.role}`}>{m.content}</div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            <div className="chatInput">
              <input
                className="input"
                ref={inputRef}
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
                className={`btn mic ${isRecording ? "rec" : ""}`}
                type="button"
                title={
                  speechSupported
                    ? isRecording
                      ? "Arrêter la dictée"
                      : "Dictée vocale"
                    : "Dictée vocale non supportée"
                }
                onClick={toggleDictation}
                disabled={!selectedConversationId || sending || !speechSupported}
              >
                <svg className="micIcon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm6-3a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.09A6 6 0 0 0 18 11z"
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

      {/* Minimal styles */}
      <style jsx>{`
        .page {
          min-height: 100vh;
          background: #050608;
          color: #e9eef6;
        }
        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 18px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          gap: 10px;
        }
        .topbarTitle {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .agentName {
          font-weight: 700;
        }
        .agentRole {
          font-size: 12px;
          opacity: 0.7;
        }

        .layout {
          display: grid;
          grid-template-columns: 320px 1fr;
          gap: 12px;
          padding: 12px;
        }

        .sidebar {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 18px;
          padding: 12px;
          min-height: calc(100vh - 70px);
        }
        .sidebarHeader {
          font-weight: 700;
          margin-bottom: 10px;
        }
        .convoList {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .convoItem {
          position: relative;
          padding: 10px 12px;
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.02);
          cursor: pointer;
        }
        .convoItem.active {
          border-color: rgba(255, 130, 30, 0.35);
          background: rgba(255, 130, 30, 0.08);
        }
        .convoTitle {
          font-size: 13px;
          font-weight: 600;
        }
        .convoMeta {
          font-size: 11px;
          opacity: 0.7;
          margin-top: 4px;
        }
        .deleteBtn {
          position: absolute;
          top: 8px;
          right: 10px;
          border: none;
          background: transparent;
          color: rgba(255, 255, 255, 0.7);
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
        }

        .main {
          min-height: calc(100vh - 70px);
        }
        .chatCard {
          height: calc(100vh - 94px);
          display: flex;
          flex-direction: column;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 18px;
          overflow: hidden;
        }

        .chatHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          gap: 10px;
        }
        .chatHeaderLeft {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .avatar {
          width: 42px;
          height: 42px;
          border-radius: 50%;
          overflow: hidden;
          background: rgba(255, 255, 255, 0.06);
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
          font-size: 18px;
          opacity: 0.8;
        }
        .hTitle {
          font-weight: 700;
        }
        .hSub {
          font-size: 12px;
          opacity: 0.7;
        }

        .chatBody {
          flex: 1;
          padding: 14px;
          overflow: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .msgRow {
          display: flex;
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
        .msgBubble.user {
          border-color: rgba(255, 130, 30, 0.25);
          background: rgba(255, 130, 30, 0.08);
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
          background: rgba(255, 255, 255, 0.02);
          color: #e9eef6;
          padding: 0 14px;
          outline: none;
        }
        .input:focus {
          border-color: rgba(255, 130, 30, 0.35);
          box-shadow: 0 0 0 3px rgba(255, 130, 30, 0.08);
        }

        .btn {
          height: 48px;
          border-radius: 16px;
          padding: 0 18px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.02);
          color: #e9eef6;
          cursor: pointer;
          font-weight: 700;
        }
        .btn:hover {
          border-color: rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.04);
        }
        .btn.send {
          border-color: rgba(255, 130, 30, 0.35);
          background: rgba(255, 130, 30, 0.12);
        }

        .btn.mic {
          width: 48px;
          height: 48px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-color: rgba(255, 130, 30, 0.45);
          background: rgba(255, 130, 30, 0.18);
          color: rgba(255, 180, 90, 0.95);
          padding: 0;
        }

        .btn.mic:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        .btn.mic.rec {
          border-color: rgba(255, 80, 80, 0.55);
          background: rgba(255, 80, 80, 0.18);
          color: rgba(255, 200, 200, 0.95);
        }

        .micIcon {
          width: 22px;
          height: 22px;
          display: block;
        }

        .chatFooter {
          padding: 10px 14px 14px;
        }
        .muted {
          opacity: 0.7;
          padding: 10px 2px;
        }
        .mutedSmall {
          opacity: 0.65;
          font-size: 12px;
        }
        .error {
          background: rgba(180, 30, 30, 0.25);
          border: 1px solid rgba(180, 30, 30, 0.35);
          padding: 10px 12px;
          margin: 12px 14px 0;
          border-radius: 12px;
          color: #ffd9d9;
        }

        .ghost {
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: transparent;
          color: rgba(233, 238, 246, 0.9);
          border-radius: 14px;
          height: 40px;
          padding: 0 14px;
          cursor: pointer;
        }
        .primary {
          border: 1px solid rgba(255, 130, 30, 0.35);
          background: rgba(255, 130, 30, 0.12);
          color: #e9eef6;
          border-radius: 14px;
          height: 40px;
          padding: 0 14px;
          cursor: pointer;
          font-weight: 700;
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
          .chatCard {
            height: calc(100vh - 250px);
            min-height: 520px;
          }
        }
      `}</style>
    </div>
  );
}
