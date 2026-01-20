import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

export default function ChatAgent() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [agent, setAgent] = useState(null);
  const [agentId, setAgentId] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(false);

  const listRef = useRef(null);
  const inputRef = useRef(null);
  const recogRef = useRef(null);
  const [isRecording, setIsRecording] = useState(false);
  const [hasSpeech, setHasSpeech] = useState(false);

  const accent = "#F4A300";

  const agentAvatar = useMemo(() => {
    const url = agent?.image_url || "";
    return url || null;
  }, [agent]);

  function scrollToBottom() {
    try {
      const el = listRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    } catch {
      // ignore
    }
  }

  function focusInput() {
    try {
      inputRef.current?.focus();
    } catch {
      // ignore
    }
  }

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function loadAgentAndConversations(slug) {
    setLoading(true);
    setErr("");

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const user = sessionData?.session?.user;
      if (!user) {
        router.replace("/login");
        return;
      }

      // agent
      const { data: agentRow, error: aErr } = await supabase
        .from("agents")
        .select("id, slug, name, role, image_url")
        .eq("slug", slug)
        .maybeSingle();

      if (aErr || !agentRow) {
        setErr("Agent introuvable.");
        setLoading(false);
        return;
      }

      setAgent(agentRow);
      setAgentId(agentRow.id);

      // access: user_agents
      const { data: ua, error: uaErr } = await supabase
        .from("user_agents")
        .select("user_id, agent_id")
        .eq("user_id", user.id)
        .eq("agent_id", agentRow.id)
        .maybeSingle();

      if (uaErr || !ua) {
        setErr("Vous n'avez pas accès à cet agent.");
        setLoading(false);
        return;
      }

      const { data: convRows, error: cErr } = await supabase
        .from("conversations")
        .select("id, title, created_at")
        .eq("user_id", user.id)
        .eq("agent_id", agentRow.id)
        .order("created_at", { ascending: false });

      if (cErr) throw cErr;

      setConversations(convRows || []);
      if (convRows && convRows.length > 0) {
        setConversationId(convRows[0].id);
      } else {
        setConversationId(null);
        setMessages([]);
      }

      setLoading(false);
    } catch (e) {
      setErr(e?.message || "Erreur lors du chargement.");
      setLoading(false);
    }
  }

  async function loadMessages(convId) {
    if (!convId) {
      setMessages([]);
      return;
    }
    try {
      const { data: msgRows, error: mErr } = await supabase
        .from("messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true });

      if (mErr) throw mErr;
      setMessages(msgRows || []);
      setTimeout(scrollToBottom, 0);
    } catch (e) {
      setErr(e?.message || "Erreur lors du chargement des messages.");
    }
  }

  async function createConversation() {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const user = sessionData?.session?.user;
      if (!user) {
        router.replace("/login");
        return;
      }
      if (!agentId) return;

      const { data: newConv, error: insErr } = await supabase
        .from("conversations")
        .insert({ user_id: user.id, agent_id: agentId, title: "Nouvelle conversation" })
        .select("id, title, created_at")
        .single();

      if (insErr) throw insErr;
      const next = [newConv, ...conversations];
      setConversations(next);
      setConversationId(newConv.id);
      setMessages([]);
      setSidebarOpen(false);
      setTimeout(() => {
        scrollToBottom();
        focusInput();
      }, 0);
    } catch (e) {
      setErr(e?.message || "Erreur lors de la création.");
    }
  }

  async function sendMessage() {
    const text = String(input || "").trim();
    if (!text || sending) return;
    if (!agentId) return;

    setSending(true);
    setErr("");

    try {
      const token = await getAccessToken();
      if (!token) {
        router.replace("/login");
        return;
      }

      let convId = conversationId;
      if (!convId) {
        // auto-create convo if none
        const { data: sessionData } = await supabase.auth.getSession();
        const user = sessionData?.session?.user;
        if (!user) {
          router.replace("/login");
          return;
        }

        const { data: newConv, error: insErr } = await supabase
          .from("conversations")
          .insert({ user_id: user.id, agent_id: agentId, title: "Nouvelle conversation" })
          .select("id, title, created_at")
          .single();
        if (insErr) throw insErr;
        convId = newConv.id;
        setConversations((prev) => [newConv, ...prev]);
        setConversationId(convId);
      }

      const optimistic = {
        id: `tmp_${Date.now()}`,
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, optimistic]);
      setInput("");
      setTimeout(() => {
        scrollToBottom();
        focusInput();
      }, 0);

      const r = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agentSlug,
          conversationId: convId,
          message: text,
        }),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = data?.message || data?.error || `Erreur HTTP ${r.status}`;
        throw new Error(msg);
      }

      // reload messages from DB for consistency
      await loadMessages(convId);
      setTimeout(() => {
        scrollToBottom();
        focusInput();
      }, 0);
    } catch (e) {
      setErr(e?.message || "Erreur lors de l'envoi.");
      setTimeout(focusInput, 0);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function openConversation(convId) {
    setConversationId(convId);
    setSidebarOpen(false);
  }

  // Speech recognition (dictée)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setHasSpeech(false);
      return;
    }
    setHasSpeech(true);
    const r = new SpeechRecognition();
    r.lang = "fr-FR";
    r.interimResults = true;
    r.continuous = true;

    r.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const t = res?.[0]?.transcript || "";
        if (res.isFinal) finalText += t;
        else interimText += t;
      }
      if (finalText) {
        setInput((prev) => (prev ? `${prev} ${finalText}` : finalText).replace(/\s+/g, " "));
      } else if (interimText) {
        // on n'affiche pas l'interim dans l'UI (évite clignotement) — optionnel
      }
    };

    r.onerror = () => {
      setIsRecording(false);
    };

    r.onend = () => {
      setIsRecording(false);
    };

    recogRef.current = r;
    return () => {
      try {
        r.stop();
      } catch {
        // ignore
      }
      recogRef.current = null;
    };
  }, []);

  function toggleMic() {
    const r = recogRef.current;
    if (!r) return;
    if (isRecording) {
      try {
        r.stop();
      } catch {
        // ignore
      }
      setIsRecording(false);
      focusInput();
      return;
    }
    try {
      r.start();
      setIsRecording(true);
      focusInput();
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!agentSlug) return;
    loadAgentAndConversations(agentSlug);
    setSidebarOpen(false);
  }, [agentSlug]);

  useEffect(() => {
    loadMessages(conversationId);
    setTimeout(() => {
      scrollToBottom();
      focusInput();
    }, 0);
  }, [conversationId]);

  return (
    <div className="wrap">
      <style jsx global>{`
        :root {
          --bg: #070708;
          --panel: rgba(255, 255, 255, 0.04);
          --panel2: rgba(255, 255, 255, 0.06);
          --line: rgba(255, 255, 255, 0.10);
          --text: rgba(255, 255, 255, 0.92);
          --muted: rgba(255, 255, 255, 0.65);
          --accent: ${accent};
          --accent2: rgba(244, 163, 0, 0.22);
          --radius: 18px;
        }

        html,
        body {
          height: 100%;
          background: var(--bg);
        }

        * {
          box-sizing: border-box;
        }
      `}</style>

      <div className="topBar">
        <button className="iconBtn" onClick={() => setSidebarOpen(true)} aria-label="Ouvrir l'historique">
          ☰
        </button>
        <button className="ghostBtn" onClick={() => router.push("/agents")}>Retour aux agents</button>
        <div className="topBarSpacer" />
        <button className="primaryBtn" onClick={createConversation}>+ Nouvelle</button>
      </div>

      <div className="layout">
        {/* Mobile backdrop */}
        <div
          className={`backdrop ${sidebarOpen ? "show" : ""}`}
          onClick={() => setSidebarOpen(false)}
          aria-hidden={!sidebarOpen}
        />

        <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
          <div className="agentHeader">
            <div className="agentAvatar">
              {agentAvatar ? <img src={agentAvatar} alt="" /> : <div className="agentFallback">{agent?.name?.slice(0, 1) || "A"}</div>}
            </div>
            <div className="agentMeta">
              <div className="agentName">{agent?.name || ""}</div>
              <div className="agentRole">{agent?.role || ""}</div>
            </div>
          </div>

          <div className="sidebarTitle">Historique</div>

          <div className="convList">
            {conversations.map((c) => (
              <button
                key={c.id}
                className={`convItem ${c.id === conversationId ? "active" : ""}`}
                onClick={() => openConversation(c.id)}
              >
                <div className="convTitle">{c.title || "Conversation"}</div>
                <div className="convDate">{new Date(c.created_at).toLocaleString()}</div>
              </button>
            ))}

            {conversations.length === 0 && <div className="empty">Aucune conversation</div>}
          </div>
        </aside>

        <main className="main">
          {loading ? (
            <div className="center">Chargement…</div>
          ) : err ? (
            <div className="center error">{err}</div>
          ) : (
            <>
              <div className="chatHeader">
                <div className="chatHeaderTitle">{agent?.name || ""}</div>
                <div className="chatHeaderSub">{agent?.role || ""}</div>
              </div>

              <div className="messages" ref={listRef}>
                {messages.map((m) => {
                  const isUser = m.role === "user";
                  const isAssistant = m.role === "assistant";
                  return (
                    <div key={m.id} className={`msgRow ${isUser ? "right" : "left"}`}>
                      {isAssistant ? (
                        <div className="msgAvatar">
                          {agentAvatar ? <img src={agentAvatar} alt="" /> : <div className="agentFallback small">{agent?.name?.slice(0, 1) || "A"}</div>}
                        </div>
                      ) : (
                        <div className="msgAvatar spacer" />
                      )}

                      <div className={`msgBubble ${isUser ? "user" : "assistant"}`}>
                        <div className="msgText">{m.content}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="composer">
                <div className="composerInner">
                  <textarea
                    ref={inputRef}
                    className="input"
                    placeholder="Écrire…"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    rows={1}
                  />

                  <button
                    className={`micBtn ${isRecording ? "rec" : ""}`}
                    onClick={toggleMic}
                    disabled={!hasSpeech}
                    title={hasSpeech ? (isRecording ? "Arrêter la dictée" : "Dicter") : "Dictée indisponible"}
                    aria-label="Micro"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path
                        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M19 11a7 7 0 0 1-14 0"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M12 18v3"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M8 21h8"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>

                  <button className="sendBtn" onClick={sendMessage} disabled={sending || !String(input || "").trim()}>
                    Envoyer
                  </button>
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      <style jsx>{`
        .wrap {
          height: 100dvh;
          display: flex;
          flex-direction: column;
        }

        .topBar {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border-bottom: 1px solid var(--line);
          background: linear-gradient(to bottom, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02));
        }

        .topBarSpacer {
          flex: 1;
        }

        .iconBtn {
          width: 40px;
          height: 40px;
          border-radius: 12px;
          border: 1px solid var(--line);
          background: var(--panel);
          color: var(--text);
          cursor: pointer;
        }

        .ghostBtn {
          border: 1px solid var(--line);
          background: transparent;
          color: var(--text);
          padding: 10px 12px;
          border-radius: 12px;
          cursor: pointer;
        }

        .primaryBtn {
          border: 1px solid rgba(244, 163, 0, 0.45);
          background: rgba(244, 163, 0, 0.14);
          color: var(--text);
          padding: 10px 12px;
          border-radius: 12px;
          cursor: pointer;
        }

        .layout {
          flex: 1;
          min-height: 0;
          display: flex;
          position: relative;
        }

        .backdrop {
          display: none;
        }

        .sidebar {
          width: 330px;
          border-right: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.02);
          display: flex;
          flex-direction: column;
          min-height: 0;
        }

        .agentHeader {
          display: flex;
          gap: 10px;
          padding: 14px 14px 10px 14px;
          border-bottom: 1px solid var(--line);
        }

        .agentAvatar {
          width: 46px;
          height: 46px;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(255, 255, 255, 0.06);
          flex: 0 0 auto;
        }

        .agentAvatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .agentFallback {
          width: 100%;
          height: 100%;
          display: grid;
          place-items: center;
          color: var(--text);
          font-weight: 700;
        }

        .agentFallback.small {
          font-size: 12px;
        }

        .agentMeta {
          display: flex;
          flex-direction: column;
          justify-content: center;
          min-width: 0;
        }

        .agentName {
          color: var(--text);
          font-weight: 700;
          line-height: 1.1;
        }

        .agentRole {
          color: var(--muted);
          font-size: 12px;
          margin-top: 2px;
          line-height: 1.2;
        }

        .sidebarTitle {
          padding: 12px 14px 8px 14px;
          color: var(--muted);
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .convList {
          padding: 0 10px 10px 10px;
          overflow: auto;
          min-height: 0;
        }

        .convItem {
          width: 100%;
          text-align: left;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.03);
          color: var(--text);
          padding: 10px 10px;
          border-radius: 14px;
          cursor: pointer;
          margin-bottom: 10px;
        }

        .convItem.active {
          border-color: rgba(244, 163, 0, 0.50);
          background: rgba(244, 163, 0, 0.10);
        }

        .convTitle {
          font-weight: 650;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .convDate {
          margin-top: 4px;
          font-size: 11px;
          color: var(--muted);
        }

        .empty {
          padding: 10px;
          color: var(--muted);
        }

        .main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }

        .chatHeader {
          padding: 14px 16px;
          border-bottom: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.02);
        }

        .chatHeaderTitle {
          color: var(--text);
          font-weight: 800;
          line-height: 1.1;
        }

        .chatHeaderSub {
          color: var(--muted);
          margin-top: 3px;
          font-size: 12px;
        }

        .messages {
          flex: 1;
          min-height: 0;
          overflow: auto;
          padding: 18px 16px 14px 16px;
        }

        .msgRow {
          display: flex;
          gap: 10px;
          margin: 10px 0;
          align-items: flex-start;
        }

        .msgRow.right {
          justify-content: flex-end;
        }

        .msgAvatar {
          width: 34px;
          height: 34px;
          border-radius: 14px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(255, 255, 255, 0.06);
          flex: 0 0 auto;
        }

        .msgAvatar.spacer {
          width: 34px;
          height: 34px;
          border: none;
          background: transparent;
        }

        .msgAvatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .msgBubble {
          max-width: min(760px, 84%);
          padding: 12px 14px;
          border-radius: var(--radius);
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.05);
          color: var(--text);
          line-height: 1.35;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .msgBubble.assistant {
          margin-top: 6px; /* "baisse" la bulle pour laisser l'avatar respirer */
        }

        .msgBubble.user {
          border-color: rgba(244, 163, 0, 0.55);
          background: rgba(244, 163, 0, 0.22);
        }

        .composer {
          position: sticky;
          bottom: 0;
          padding: 12px 12px;
          border-top: 1px solid var(--line);
          background: rgba(7, 7, 8, 0.92);
          backdrop-filter: blur(10px);
        }

        .composerInner {
          display: flex;
          align-items: flex-end;
          gap: 10px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.04);
          border-radius: 16px;
          padding: 8px;
        }

        .input {
          flex: 1;
          resize: none;
          outline: none;
          border: none;
          background: transparent;
          color: var(--text);
          font-size: 14px;
          line-height: 1.3;
          padding: 6px 8px;
          min-height: 42px;
          max-height: 140px;
        }

        .micBtn {
          width: 44px;
          height: 44px;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.04);
          color: var(--text);
          cursor: pointer;
          display: grid;
          place-items: center;
        }

        .micBtn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        .micBtn.rec {
          border-color: rgba(244, 163, 0, 0.70);
          background: rgba(244, 163, 0, 0.16);
          color: var(--accent);
        }

        .sendBtn {
          height: 44px;
          padding: 0 16px;
          border-radius: 14px;
          border: 1px solid rgba(244, 163, 0, 0.70);
          background: rgba(244, 163, 0, 0.20);
          color: var(--text);
          font-weight: 700;
          cursor: pointer;
        }

        .sendBtn:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }

        .center {
          padding: 22px;
          color: var(--muted);
        }

        .error {
          color: rgba(255, 120, 120, 0.95);
        }

        /* Mobile */
        @media (max-width: 980px) {
          .sidebar {
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: min(360px, 88vw);
            transform: translateX(-105%);
            transition: transform 180ms ease;
            z-index: 30;
          }

          .sidebar.open {
            transform: translateX(0);
          }

          .backdrop {
            display: block;
            position: absolute;
            inset: 0;
            background: rgba(0, 0, 0, 0.55);
            opacity: 0;
            pointer-events: none;
            transition: opacity 180ms ease;
            z-index: 20;
          }

          .backdrop.show {
            opacity: 1;
            pointer-events: auto;
          }

          .msgBubble {
            max-width: 92%;
          }
        }
      `}</style>
    </div>
  );
}
