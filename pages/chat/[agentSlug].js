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
  if (!agentName) return "Bonjour ! Comment puis-je vous aider ?";
  return `Bonjour ! Je suis ${agentName}. Comment puis-je vous aider ?`;
}

export default function ChatAgent() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const messagesEndRef = useRef(null);

  // Micro (dictée vocale) via Web Speech API (si supporté par le navigateur)
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
    const rec = recognitionRef.current;
    if (!rec) return;

    if (isRecording) {
      try {
        rec.stop();
      } catch (_) {}
      setIsRecording(false);
      return;
    }

    try {
      rec.start();
      setIsRecording(true);
    } catch (_) {
      setIsRecording(false);
    }
  }

  const [user, setUser] = useState(null);

  const [agent, setAgent] = useState(null);
  const [loadingAgent, setLoadingAgent] = useState(true);

  const [conversations, setConversations] = useState([]);
  const [loadingConvs, setLoadingConvs] = useState(true);

  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [messages, setMessages] = useState([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const [err, setErr] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [creatingConv, setCreatingConv] = useState(false);
  const [renamingConvId, setRenamingConvId] = useState("");
  const [renameValue, setRenameValue] = useState("");

  const accent = "#FF8A00";

  async function getSessionToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function loadUser() {
    const { data } = await supabase.auth.getUser();
    setUser(data?.user || null);
  }

  async function loadAgent(slug) {
    setLoadingAgent(true);
    setErr("");
    try {
      const token = await getSessionToken();
      if (!token) {
        router.push("/login");
        return;
      }

      const { data, error } = await supabase
        .from("agents")
        .select("id, slug, name, avatar_url, description")
        .eq("slug", slug)
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        setAgent(null);
        return;
      }
      setAgent(data);
    } catch (e) {
      setErr(e?.message || "Erreur chargement agent");
    } finally {
      setLoadingAgent(false);
    }
  }

  async function loadConversations(slug) {
    setLoadingConvs(true);
    setErr("");
    try {
      const token = await getSessionToken();
      if (!token) {
        router.push("/login");
        return;
      }

      const res = await fetch(`/api/conversations?agentSlug=${encodeURIComponent(slug)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Erreur conversations");
      setConversations(data?.conversations || []);
    } catch (e) {
      setErr(e?.message || "Erreur chargement conversations");
    } finally {
      setLoadingConvs(false);
    }
  }

  async function loadMessages(conversationId) {
    if (!conversationId) return;
    setLoadingMsgs(true);
    setErr("");
    try {
      const token = await getSessionToken();
      if (!token) {
        router.push("/login");
        return;
      }

      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Erreur messages");
      setMessages(data?.messages || []);
    } catch (e) {
      setErr(e?.message || "Erreur chargement messages");
    } finally {
      setLoadingMsgs(false);
    }
  }

  function openConversation(id) {
    setSelectedConversationId(id);
    setSidebarOpen(false);
    setTimeout(() => inputRef.current?.focus?.(), 0);
  }

  async function handleNewConversation() {
    if (!user?.id) return;
    if (!agentSlug || typeof agentSlug !== "string") return;

    try {
      setCreatingConv(true);
      setErr("");

      const token = await getSessionToken();
      if (!token) {
        router.push("/login");
        return;
      }

      const res = await fetch("/api/conversations/init", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          agentSlug,
          title: formatTitleFallback(agent?.name),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Erreur création conversation");

      const newId = data?.conversationId;
      await loadConversations(agentSlug);

      if (newId) {
        setSelectedConversationId(newId);
        await loadMessages(newId);
        setMessages((prev) => {
          if (prev && prev.length) return prev;
          return [{ role: "assistant", content: defaultWelcome(agent?.name), created_at: new Date().toISOString() }];
        });
        setTimeout(() => inputRef.current?.focus?.(), 0);
      }
    } catch (e) {
      setErr(e?.message || "Erreur création conversation");
    } finally {
      setCreatingConv(false);
    }
  }

  async function handleDeleteConversation(id) {
    if (!id) return;
    if (!confirm("Supprimer cette conversation ?")) return;

    try {
      setErr("");
      const token = await getSessionToken();
      if (!token) {
        router.push("/login");
        return;
      }

      const res = await fetch("/api/conversations/delete", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: id }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Erreur suppression");

      await loadConversations(agentSlug);

      if (selectedConversationId === id) {
        setSelectedConversationId("");
        setMessages([]);
      }
    } catch (e) {
      setErr(e?.message || "Erreur suppression conversation");
    }
  }

  function startRename(conv) {
    setRenamingConvId(conv.id);
    setRenameValue(conv.title || "");
  }

  function cancelRename() {
    setRenamingConvId("");
    setRenameValue("");
  }

  async function saveRename(convId) {
    const title = (renameValue || "").trim();
    if (!title) return;

    try {
      setErr("");
      const token = await getSessionToken();
      if (!token) {
        router.push("/login");
        return;
      }

      const res = await fetch(`/api/conversations/${convId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Erreur renommage");

      setRenamingConvId("");
      setRenameValue("");
      await loadConversations(agentSlug);
    } catch (e) {
      setErr(e?.message || "Erreur renommage conversation");
    }
  }

  async function handleSend() {
    if (!selectedConversationId) return;
    const text = (input || "").trim();
    if (!text) return;
    if (!agentSlug || typeof agentSlug !== "string") return;

    try {
      setSending(true);
      setErr("");

      const token = await getSessionToken();
      if (!token) {
        router.push("/login");
        return;
      }

      const optimisticUserMsg = {
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimisticUserMsg]);

      setInput("");

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          agentSlug,
          conversationId: selectedConversationId,
          message: text,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || data?.error || "Erreur chat");

      const reply = data?.reply || "";
      if (reply) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: reply, created_at: new Date().toISOString() },
        ]);
      }

      setTimeout(() => inputRef.current?.focus?.(), 0);
    } catch (e) {
      setErr(e?.message || "Erreur envoi");
    } finally {
      setSending(false);
    }
  }

  // Boot
  useEffect(() => {
    loadUser();
  }, []);

  useEffect(() => {
    if (!agentSlug || typeof agentSlug !== "string") return;
    loadAgent(agentSlug);
    loadConversations(agentSlug);
    setSelectedConversationId("");
    setMessages([]);
    setSidebarOpen(true);
  }, [agentSlug]);

  useEffect(() => {
    if (!selectedConversationId) return;
    loadMessages(selectedConversationId);
  }, [selectedConversationId]);

  const convTitle = useMemo(() => {
    const c = conversations.find((x) => x.id === selectedConversationId);
    return c?.title || formatTitleFallback(agent?.name);
  }, [conversations, selectedConversationId, agent?.name]);

  const showEmptyState = useMemo(() => {
    return !loadingConvs && conversations.length === 0;
  }, [loadingConvs, conversations]);

  // Auto scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loadingMsgs]);

  return (
    <div className="page">
      <div className="topbar">
        <div className="left">
          <button className="btn ghost" onClick={() => router.push("/agents")}>
            ← Agents
          </button>
        </div>

        <div className="center">
          <div className="title">{agent?.name || "Agent"}</div>
          <div className="subtitle">{convTitle}</div>
        </div>

        <div className="right">
          <button className="btn ghost" onClick={() => setSidebarOpen((v) => !v)}>
            {sidebarOpen ? "Masquer" : "Historique"}
          </button>
        </div>
      </div>

      <div className="layout">
        {/* Sidebar */}
        <div className={`sidebar ${sidebarOpen ? "open" : ""}`}>
          <div className="sidebarHeader">
            <button className="btn" onClick={handleNewConversation} disabled={creatingConv || loadingAgent}>
              {creatingConv ? "Création..." : "Nouvelle"}
            </button>
          </div>

          <div className="convList">
            {loadingConvs ? (
              <div className="muted">Chargement...</div>
            ) : showEmptyState ? (
              <div className="muted">Aucune conversation. Créez-en une.</div>
            ) : (
              conversations.map((c) => {
                const active = c.id === selectedConversationId;
                const isRenaming = renamingConvId === c.id;

                return (
                  <div key={c.id} className={`convItem ${active ? "active" : ""}`}>
                    {isRenaming ? (
                      <div className="renameRow">
                        <input
                          className="renameInput"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveRename(c.id);
                            if (e.key === "Escape") cancelRename();
                          }}
                        />
                        <button className="btn mini" onClick={() => saveRename(c.id)}>
                          OK
                        </button>
                        <button className="btn mini ghost" onClick={cancelRename}>
                          X
                        </button>
                      </div>
                    ) : (
                      <>
                        <button className="convMain" onClick={() => openConversation(c.id)}>
                          <div className="convTitle">{c.title || "Sans titre"}</div>
                          <div className="convMeta">
                            {c.created_at ? new Date(c.created_at).toLocaleDateString() : ""}
                          </div>
                        </button>

                        <div className="convActions">
                          <button className="btn mini ghost" onClick={() => startRename(c)} title="Renommer">
                            ✎
                          </button>
                          <button
                            className="btn mini ghost danger"
                            onClick={() => handleDeleteConversation(c.id)}
                            title="Supprimer"
                          >
                            🗑
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Chat */}
        <div className="chat">
          <div className="chatHeader">
            <div className="agentPill">
              <div className="agentAvatar">
                {agent?.avatar_url ? (
                  <img src={agent.avatar_url} alt={agent?.name || "agent"} />
                ) : (
                  <div className="avatarFallback">{(agent?.name || "A").slice(0, 1)}</div>
                )}
              </div>
              <div className="agentInfo">
                <div className="agentName">{agent?.name || "Agent"}</div>
                <div className="agentDesc">{agent?.description || ""}</div>
              </div>
            </div>
          </div>

          <div className="chatBody">
            {!selectedConversationId ? (
              <div className="empty">
                <div className="emptyTitle">Choisissez une conversation</div>
                <div className="emptyText">
                  Créez une nouvelle conversation ou sélectionnez-en une dans l’historique.
                </div>
              </div>
            ) : loadingMsgs ? (
              <div className="muted">Chargement des messages...</div>
            ) : (
              <>
                {messages.length === 0 ? (
                  <div className="muted">Aucun message. Écrivez le premier.</div>
                ) : (
                  messages.map((m, idx) => {
                    const isUser = m.role === "user";
                    const ts = m.created_at ? new Date(m.created_at).toLocaleTimeString().slice(0, 5) : "";
                    return (
                      <div key={idx} className={`msgRow ${isUser ? "user" : "assistant"}`}>
                        {!isUser && (
                          <div className="msgAvatar">
                            {agent?.avatar_url ? (
                              <img src={agent.avatar_url} alt={agent?.name || "agent"} />
                            ) : (
                              <div className="avatarMini">{(agent?.name || "A").slice(0, 1)}</div>
                            )}
                          </div>
                        )}
                        <div className={`msgBubble ${isUser ? "user" : "assistant"}`}>
                          <div className="msgText">{m.content}</div>
                          <div className="msgMeta">{ts}</div>
                        </div>
                      </div>
                    );
                  })
                )}

                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          <div className="chatFooter">
            {err ? <div className="error">{err}</div> : null}

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

              {/* Micro (dictée vocale) */}
              <button
                className={`btn mic ${isRecording ? "rec" : ""}`}
                type="button"
                title={
                  speechSupported
                    ? isRecording
                      ? "Arrêter la dictée"
                      : "Dicter"
                    : "Dictée vocale non supportée"
                }
                onClick={toggleDictation}
                disabled={!speechSupported || sending}
                aria-label="Micro"
              >
                {isRecording ? "⏺" : "🎙"}
              </button>

              <button className="btn send" onClick={handleSend} disabled={!selectedConversationId || sending}>
                {sending ? "Envoi..." : "Envoyer"}
              </button>
            </div>
          </div>
        </div>
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
          background: radial-gradient(1200px 200px at 50% -20%, rgba(255, 130, 30, 0.18), transparent);
        }

        .left,
        .right {
          width: 220px;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .center {
          flex: 1;
          text-align: center;
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .title {
          font-weight: 800;
          letter-spacing: 0.2px;
          font-size: 16px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .subtitle {
          font-size: 12px;
          color: rgba(233, 238, 246, 0.7);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
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

        .btn.ghost {
          background: transparent;
          border-color: rgba(255, 255, 255, 0.12);
        }

        .btn.send {
          border-color: rgba(255, 138, 0, 0.75);
          background: linear-gradient(180deg, rgba(255, 138, 0, 0.28), rgba(255, 138, 0, 0.18));
          box-shadow: 0 12px 30px rgba(255, 138, 0, 0.16);
        }

        .btn.send:hover {
          border-color: rgba(255, 138, 0, 0.95);
          background: linear-gradient(180deg, rgba(255, 138, 0, 0.36), rgba(255, 138, 0, 0.22));
        }

        .btn.mini {
          padding: 8px 10px;
          border-radius: 12px;
          font-size: 12px;
        }

        .danger {
          color: rgba(255, 120, 120, 0.95);
        }

        .layout {
          display: grid;
          grid-template-columns: 320px 1fr;
          min-height: calc(100vh - 64px);
        }

        .sidebar {
          border-right: 1px solid rgba(255, 255, 255, 0.06);
          background: rgba(255, 255, 255, 0.015);
          display: flex;
          flex-direction: column;
          min-width: 0;
        }

        .sidebarHeader {
          padding: 14px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .convList {
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          overflow: auto;
          height: calc(100vh - 64px - 68px);
        }

        .convItem {
          display: flex;
          gap: 8px;
          align-items: stretch;
          border: 1px solid rgba(255, 255, 255, 0.06);
          background: rgba(255, 255, 255, 0.02);
          border-radius: 16px;
          overflow: hidden;
        }

        .convItem.active {
          border-color: rgba(255, 138, 0, 0.55);
          background: rgba(255, 138, 0, 0.10);
        }

        .convMain {
          flex: 1;
          text-align: left;
          background: transparent;
          border: 0;
          color: inherit;
          padding: 12px 12px;
          cursor: pointer;
          min-width: 0;
        }

        .convTitle {
          font-weight: 800;
          font-size: 13px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .convMeta {
          margin-top: 4px;
          font-size: 11px;
          color: rgba(233, 238, 246, 0.6);
        }

        .convActions {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 10px 10px 10px 0;
        }

        .renameRow {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px;
          width: 100%;
        }

        .renameInput {
          flex: 1;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(0, 0, 0, 0.35);
          color: #e9eef6;
          padding: 8px 10px;
          outline: none;
        }

        .chat {
          display: flex;
          flex-direction: column;
          min-width: 0;
        }

        .chatHeader {
          padding: 14px 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          background: rgba(255, 255, 255, 0.01);
        }

        .agentPill {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }

        .agentAvatar {
          width: 44px;
          height: 44px;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.04);
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
        }

        .agentAvatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center;
        }

        .avatarFallback {
          font-weight: 900;
          color: rgba(233, 238, 246, 0.9);
        }

        .agentInfo {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .agentName {
          font-weight: 900;
          font-size: 14px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .agentDesc {
          font-size: 12px;
          color: rgba(233, 238, 246, 0.65);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .chatBody {
          flex: 1;
          padding: 16px;
          overflow: auto;
          height: calc(100vh - 64px - 72px - 68px);
        }

        .empty {
          border: 1px dashed rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.02);
          border-radius: 18px;
          padding: 18px;
        }

        .emptyTitle {
          font-weight: 900;
          margin-bottom: 6px;
        }

        .emptyText {
          color: rgba(233, 238, 246, 0.65);
          font-size: 13px;
        }

        .muted {
          color: rgba(233, 238, 246, 0.65);
          font-size: 13px;
        }

        .msgRow {
          display: flex;
          gap: 10px;
          align-items: flex-start;
          margin-bottom: 12px;
        }

        .msgRow.user {
          justify-content: flex-end;
        }

        .msgAvatar {
          width: 34px;
          height: 34px;
          border-radius: 14px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.04);
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
          margin-top: 2px;
        }

        .msgAvatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center;
        }

        .avatarMini {
          font-weight: 900;
          font-size: 12px;
        }

        .msgBubble {
          max-width: min(780px, 80%);
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.03);
          border-radius: 18px;
          padding: 12px 12px 10px;
        }

        .msgBubble.user {
          border-color: rgba(255, 138, 0, 0.55);
          background: rgba(255, 138, 0, 0.20);
          box-shadow: 0 10px 30px rgba(255, 138, 0, 0.10);
        }

        .msgText {
          white-space: pre-wrap;
          line-height: 1.35;
          font-size: 14px;
        }

        .msgMeta {
          margin-top: 6px;
          font-size: 11px;
          color: rgba(233, 238, 246, 0.55);
          text-align: right;
        }

        .chatFooter {
          padding: 10px 14px 14px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          background: rgba(0, 0, 0, 0.20);
        }

        .chatInput {
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .input {
          flex: 1;
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(0, 0, 0, 0.35);
          color: #e9eef6;
          padding: 14px 14px;
          outline: none;
          font-size: 14px;
        }

        .btn.mic {
          width: 48px;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .btn.mic.rec {
          border-color: rgba(255, 80, 80, 0.65);
          background: rgba(255, 80, 80, 0.14);
        }

        .error {
          margin-bottom: 10px;
          border: 1px solid rgba(255, 120, 120, 0.35);
          background: rgba(255, 120, 120, 0.10);
          padding: 10px 12px;
          border-radius: 14px;
          color: rgba(255, 200, 200, 0.95);
          font-size: 13px;
        }

        @media (max-width: 980px) {
          .layout {
            grid-template-columns: 1fr;
          }
          .sidebar {
            position: fixed;
            top: 64px;
            left: 0;
            width: min(360px, 92vw);
            height: calc(100vh - 64px);
            transform: translateX(-102%);
            transition: transform 160ms ease;
            z-index: 30;
            background: rgba(7, 8, 10, 0.96);
            backdrop-filter: blur(10px);
          }
          .sidebar.open {
            transform: translateX(0%);
          }
          .left,
          .right {
            width: auto;
          }
          .chatBody {
            height: calc(100vh - 64px - 72px - 84px);
          }
        }
      `}</style>
    </div>
  );
}
