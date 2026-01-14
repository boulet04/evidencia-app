// pages/chat.js
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function ChatPage() {
  const [sessionEmail, setSessionEmail] = useState("");
  const [userId, setUserId] = useState("");

  const [agentSlug, setAgentSlug] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentDesc, setAgentDesc] = useState("");
  const [agentAvatar, setAgentAvatar] = useState("");

  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const [conversations, setConversations] = useState([]);
  const [selectedConvId, setSelectedConvId] = useState("");
  const [messages, setMessages] = useState([]);

  const [input, setInput] = useState("");
  const endRef = useRef(null);
  const textareaRef = useRef(null);

  const recognitionRef = useRef(null);
  const finalTextRef = useRef("");
  const [micSupported, setMicSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [micSupported, setMicSupported] = useState(false);

  const DEFAULT_TITLE = "Nouvelle conversation";

  function safeStr(v) {
    return (v ?? "").toString();
  }

  function titleFromMessage(message) {
    const s = safeStr(message).trim().replace(/\s+/g, " ");
    if (!s) return DEFAULT_TITLE;
    return s.length > 60 ? s.slice(0, 60) + "…" : s;
  }

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  function goBack() {
    window.location.href = "/agents";
  }

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const SR =
      typeof window !== "undefined"
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;

    setMicSupported(Boolean(SR));
  }, []);
  useEffect(() => {
  if (typeof window === "undefined") return;

  const mq = window.matchMedia("(max-width: 900px)");

  const apply = () => setIsMobile(mq.matches);
  apply();

  if (mq.addEventListener) mq.addEventListener("change", apply);
  else mq.addListener(apply);

  return () => {
    if (mq.removeEventListener) mq.removeEventListener("change", apply);
    else mq.removeListener(apply);
  };
}, []);


  function startMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    try {
      recognitionRef.current?.stop?.();
    } catch (_) {}
    recognitionRef.current = null;

    const rec = new SR();
    recognitionRef.current = rec;

    rec.lang = "fr-FR";
    rec.interimResults = true;
    rec.continuous = false;

    finalTextRef.current = "";
    setListening(true);

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0]?.transcript || "";
        if (res.isFinal) finalTextRef.current += txt;
        else interim += txt;
      }
      setInput((finalTextRef.current + interim).trim());
    };

    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);

    try {
      rec.start();
    } catch (_) {
      setListening(false);
    }
  }

  function stopMic() {
    try {
      recognitionRef.current?.stop?.();
    } catch (_) {}
    recognitionRef.current = null;
    setListening(false);
  }

  async function initGreetingIfEmpty(conversationId) {
    const token = await getAccessToken();
    if (!token) return;

    try {
      await fetch("/api/conversations/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ agentSlug, conversationId }),
      });
    } catch (_) {}
  }

  async function loadMessages(conversationId) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error) {
      setErrorMsg("Impossible de charger les messages.");
      setMessages([]);
      return [];
    }

    const list = (data || []).filter((m) => {
      if (m.role === "system") return false;
      if ((m.content || "").startsWith("MEMORY:")) return false;
      if ((m.content || "").startsWith("DRAFT_EMAIL:")) return false;
      if ((m.content || "").startsWith("DRAFT_EMAIL_SENT:")) return false;
      return true;
    });

    setMessages(list);
    return list;
  }

  async function createConversationNow(initialTitle = DEFAULT_TITLE) {
    if (!userId || !agentSlug) return "";

    const { data, error } = await supabase
      .from("conversations")
      .insert({
        user_id: userId,
        agent_slug: agentSlug,
        title: initialTitle,
        archived: false,
      })
      .select("id")
      .single();

    if (!error && data?.id) return data.id;

    const { data: data2, error: error2 } = await supabase
      .from("conversations")
      .insert({
        user_id: userId,
        agent_slug: agentSlug,
        title: initialTitle,
      })
      .select("id")
      .single();

    if (error2 || !data2?.id) return "";
    return data2.id;
  }

  async function updateConversationTitleIfNeeded(conversationId, firstUserMessage) {
    const conv = (conversations || []).find((c) => c.id === conversationId);
    const currentTitle = conv?.title || DEFAULT_TITLE;

    if (!currentTitle || currentTitle === DEFAULT_TITLE) {
      const newTitle = titleFromMessage(firstUserMessage);
      try {
        await supabase.from("conversations").update({ title: newTitle }).eq("id", conversationId);
      } catch (_) {}
    }
  }

  async function refreshConversations(uid, slug) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, created_at, title, archived, agent_slug, user_id")
      .eq("user_id", uid)
      .eq("agent_slug", slug)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      const { data: data2, error: error2 } = await supabase
        .from("conversations")
        .select("id, created_at, title, agent_slug, user_id")
        .eq("user_id", uid)
        .eq("agent_slug", slug)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error2) {
        setErrorMsg("Impossible de charger l'historique.");
        setConversations([]);
        setSelectedConvId("");
        setMessages([]);
        return { list: [], firstId: "" };
      }

      setConversations(data2 || []);
      const firstId = data2?.[0]?.id || "";
      return { list: data2 || [], firstId };
    }

    const filtered = (data || []).filter((c) => c.archived !== true);
    setConversations(filtered);
    const firstId = filtered?.[0]?.id || "";
    return { list: filtered, firstId };
  }

  async function ensureConversationExistsWithGreeting() {
    const { firstId } = await refreshConversations(userId, agentSlug);

    if (firstId) {
      setSelectedConvId(firstId);
      await loadMessages(firstId);
      return;
    }

    const convId = await createConversationNow(DEFAULT_TITLE);
    if (!convId) {
      setSelectedConvId("");
      setMessages([]);
      return;
    }

    await refreshConversations(userId, agentSlug);
    setSelectedConvId(convId);

    await initGreetingIfEmpty(convId);
    await loadMessages(convId);
  }

  async function deleteConversation(conversationId) {
    setErrorMsg("");
    const token = await getAccessToken();
    if (!token) {
      setErrorMsg("Session expirée. Reconnectez-vous.");
      return;
    }

    try {
      const resp = await fetch("/api/conversations/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ conversationId }),
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok) {
        setErrorMsg(json?.error || "Suppression impossible.");
        return;
      }

      const { firstId } = await refreshConversations(userId, agentSlug);

      if (selectedConvId === conversationId) {
        if (firstId) {
          setSelectedConvId(firstId);
          await loadMessages(firstId);
        } else {
          const newId = await createConversationNow(DEFAULT_TITLE);
          if (newId) {
            await refreshConversations(userId, agentSlug);
            setSelectedConvId(newId);
            await initGreetingIfEmpty(newId);
            await loadMessages(newId);
          } else {
            setSelectedConvId("");
            setMessages([]);
          }
        }
      }

      setTimeout(() => textareaRef.current?.focus?.(), 0);
    } catch (_) {
      setErrorMsg("Erreur suppression conversation.");
    }
  }

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);

        const { data: sess } = await supabase.auth.getSession();
        const user = sess?.session?.user;
        if (!user) {
          window.location.href = "/login";
          return;
        }

        setUserId(user.id);
        setSessionEmail(user.email || "");

        const url = new URL(window.location.href);
        const slug = safeStr(url.searchParams.get("agent")).trim().toLowerCase();
        if (!slug) {
          window.location.href = "/agents";
          return;
        }
        setAgentSlug(slug);

        const { data: agent, error: agentErr } = await supabase
          .from("agents")
          .select("slug, name, description, avatar_url")
          .eq("slug", slug)
          .maybeSingle();

        if (agentErr || !agent) {
          setErrorMsg("Erreur chargement agent.");
          setLoading(false);
          return;
        }

        setAgentName(agent.name || slug);
        setAgentDesc(agent.description || "");
        setAgentAvatar(agent.avatar_url || "");

        setLoading(false);
      } catch (_) {
        setErrorMsg("Erreur initialisation chat.");
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!userId || !agentSlug) return;
    (async () => {
      setErrorMsg("");
      await ensureConversationExistsWithGreeting();
      setTimeout(() => textareaRef.current?.focus?.(), 0);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, agentSlug]);

  async function handleNewConversation() {
    setErrorMsg("");
    const convId = await createConversationNow(DEFAULT_TITLE);
    if (!convId) {
      setErrorMsg("Impossible de créer une nouvelle conversation.");
      return;
    }

    await refreshConversations(userId, agentSlug);
    setSelectedConvId(convId);

    await initGreetingIfEmpty(convId);
    await loadMessages(convId);

    setTimeout(() => textareaRef.current?.focus?.(), 0);
  }

  async function sendMessage() {
    if (!input.trim() || sending) return;
    setErrorMsg("");
    setSending(true);

    try {
      let convId = selectedConvId;

      if (!convId) {
        convId = await createConversationNow(DEFAULT_TITLE);
        if (!convId) {
          setErrorMsg("Impossible de créer une conversation.");
          setSending(false);
          setTimeout(() => textareaRef.current?.focus?.(), 0);
          return;
        }
        await refreshConversations(userId, agentSlug);
        setSelectedConvId(convId);

        await initGreetingIfEmpty(convId);
        await loadMessages(convId);
      }

      const token = await getAccessToken();
      if (!token) {
        setErrorMsg("Session expirée. Reconnectez-vous.");
        setSending(false);
        setTimeout(() => textareaRef.current?.focus?.(), 0);
        return;
      }

      const userText = input.trim();
      setInput("");

      setTimeout(() => textareaRef.current?.focus?.(), 0);

      setMessages((prev) => [
        ...(prev || []),
        { id: "tmp-" + Date.now(), role: "user", content: userText, created_at: new Date().toISOString() },
      ]);

      await updateConversationTitleIfNeeded(convId, userText);
      await refreshConversations(userId, agentSlug);

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agentSlug,
          conversationId: convId,
          message: userText,
        }),
      });

      const json = await resp.json().catch(() => null);

      if (!resp.ok) {
        setErrorMsg(json?.error || "Erreur lors de l’envoi.");
        await loadMessages(convId);
        setSending(false);
        setTimeout(() => textareaRef.current?.focus?.(), 0);
        return;
      }

      if (json?.conversationId && json.conversationId !== convId) {
        convId = json.conversationId;
        setSelectedConvId(convId);
      }

      await loadMessages(convId);
      setSending(false);
      setTimeout(() => textareaRef.current?.focus?.(), 0);
    } catch (_) {
      setErrorMsg("Erreur lors de l’envoi.");
      setSending(false);
      setTimeout(() => textareaRef.current?.focus?.(), 0);
    }
  }

  const headerRightLabel = useMemo(() => sessionEmail || "", [sessionEmail]);

  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.bg} aria-hidden="true" />
        <div style={styles.center}>Chargement…</div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <div style={styles.bg} aria-hidden="true" />

      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <button style={styles.backBtn} onClick={goBack}>
            ← Retour aux agents
          </button>
        </div>

        <div style={styles.topCenter}>
          <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.brandLogo} />
        </div>

        <div style={styles.topRight}>
          <div style={styles.userLabel} title={headerRightLabel}>
            {headerRightLabel || "Utilisateur"}
          </div>
          <button style={styles.logoutBtn} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </header>

         <div
        style={{
          ...styles.shell,
          gridTemplateColumns: isMobile ? "1fr" : "320px 1fr",
          gridTemplateRows: isMobile ? "260px 1fr" : undefined,
          padding: isMobile ? 10 : styles.shell.padding,
          gap: isMobile ? 10 : styles.shell.gap,
        }}
      >

        <aside
          style={{
            ...styles.sidebar,
            ...(isMobile ? { height: "100%" } : {}),
          }}
        >

          <div style={styles.sideTop}>
            <div style={styles.sideTitle}>Historique</div>
            <button style={styles.newBtn} onClick={handleNewConversation} title="Nouvelle conversation">
              + Nouvelle
            </button>
          </div>

          <div style={styles.convList}>
            {(conversations || []).map((c) => (
              <div key={c.id} style={styles.convItemWrap}>
                <button
                  style={{
                    ...styles.convItem,
                    ...(selectedConvId === c.id ? styles.convItemActive : {}),
                  }}
                  onClick={async () => {
                    setSelectedConvId(c.id);
                    await loadMessages(c.id);
                    setTimeout(() => textareaRef.current?.focus?.(), 0);
                  }}
                  title={c.title || ""}
                >
                  <div style={styles.convTitle}>{c.title || "Conversation"}</div>
                  <div style={styles.convMeta}>
                    {c.created_at ? new Date(c.created_at).toLocaleString("fr-FR") : ""}
                  </div>
                </button>

                <button
                  type="button"
                  style={styles.convDeleteBtn}
                  title="Supprimer la conversation"
                  aria-label="Supprimer"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    deleteConversation(c.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section
          style={{
            ...styles.chatCol,
            ...(isMobile ? { height: "100%" } : {}),
          }}
        >

          <div style={styles.agentHeader}>
            {agentAvatar ? (
              <img src={agentAvatar} alt={agentName} style={styles.avatar} />
            ) : (
              <div style={styles.avatarFallback} />
            )}

            <div style={styles.agentMeta}>
              <div style={styles.agentName}>{agentName || agentSlug}</div>
              <div style={styles.agentDesc}>{agentDesc}</div>
            </div>
          </div>

          <div style={styles.chatBox}>
            {(messages || []).map((m, idx) => (
              <div
                key={m.id || idx}
                style={{
                  ...styles.msgRow,
                  justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    ...styles.bubble,
                    ...(m.role === "user" ? styles.bubbleUser : styles.bubbleAgent),
                  }}
                >
                  {m.content}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>

          {errorMsg ? <div style={styles.error}>{errorMsg}</div> : null}

          <div style={styles.inputRow}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Écrire…"
              style={styles.textarea}
              rows={1}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              disabled={sending}
            />

            <button
              type="button"
              onClick={() => {
                if (!micSupported) return;
                if (listening) stopMic();
                else startMic();
              }}
              disabled={!micSupported || sending}
              title={!micSupported ? "Micro non supporté" : listening ? "Arrêter la dictée" : "Dicter"}
              style={{
                ...styles.micBtn,
                ...(listening ? styles.micBtnOn : {}),
                ...(micSupported ? {} : styles.micBtnOff),
              }}
              aria-label="Microphone"
            >
              {listening ? <StopIcon /> : <MicIcon />}
            </button>

            <button
              onClick={() => {
                sendMessage();
                setTimeout(() => textareaRef.current?.focus?.(), 0);
              }}
              disabled={sending || !input.trim()}
              style={styles.sendBtn}
            >
              {sending ? "Envoi…" : "Envoyer"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z"
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
  );
}

function StopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

const styles = {
  page: {
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    background: "#0b0b0f",
    color: "#fff",
    position: "relative",
    overflow: "hidden",
  },
  bg: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(1200px 600px at 20% 10%, rgba(255,140,0,0.10), transparent 60%), radial-gradient(1000px 700px at 80% 30%, rgba(255,255,255,0.06), transparent 55%)",
    pointerEvents: "none",
  },

  topbar: {
    position: "relative",
    zIndex: 2,
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    padding: "14px 18px",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.28)",
    backdropFilter: "blur(10px)",
    flex: "0 0 auto",
  },
  topLeft: { display: "flex", alignItems: "center", gap: 12 },
  topCenter: { display: "flex", justifyContent: "center", alignItems: "center" },
  topRight: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12 },

  backBtn: {
    padding: "8px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(0,0,0,0.35)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  brandLogo: {
    height: 26,
    width: "auto",
    opacity: 0.95,
    filter: "drop-shadow(0 6px 18px rgba(0,0,0,.55))",
    display: "block",
    userSelect: "none",
  },
  userLabel: {
    fontSize: 12,
    fontWeight: 800,
    color: "rgba(238,242,255,0.78)",
    maxWidth: 240,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  logoutBtn: {
    padding: "8px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(0,0,0,0.35)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },

  shell: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gridTemplateColumns: "320px 1fr",
    gap: 14,
    padding: 14,
    flex: "1 1 auto",
    minHeight: 0,
    overflow: "hidden",
  },

  sidebar: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.28)",
    backdropFilter: "blur(10px)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  sideTop: {
    padding: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    flex: "0 0 auto",
  },
  sideTitle: {
    fontWeight: 900,
    fontSize: 13,
    color: "rgba(255,255,255,0.92)",
  },
  newBtn: {
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  convList: {
    padding: 10,
    display: "grid",
    gap: 10,
    overflowY: "auto",
    overflowX: "hidden",
    flex: "1 1 auto",
    minHeight: 0,
  },

  // Wrapper relatif pour placer la croix en absolute (robuste, toujours visible)
  convItemWrap: {
    position: "relative",
  },

  convItem: {
    textAlign: "left",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.26)",
    color: "#fff",
    padding: "12px 40px 12px 12px", // place pour la croix à droite
    cursor: "pointer",
    overflow: "hidden",
    width: "100%",
  },
  convItemActive: {
    border: "1px solid rgba(255,140,0,0.42)",
    background: "rgba(255,140,0,0.08)",
  },

  convTitle: {
    fontSize: 12,
    fontWeight: 900,
    marginBottom: 6,
    whiteSpace: "normal",
    wordBreak: "break-word",
    lineHeight: 1.25,
  },
  convMeta: {
    fontSize: 11,
    fontWeight: 700,
    color: "rgba(238,242,255,0.60)",
  },

  convDeleteBtn: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 28,
    height: 28,
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255, 0, 0, 0.10)",
    color: "rgba(255, 90, 90, 0.95)",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 18,
    lineHeight: "18px",
    display: "grid",
    placeItems: "center",
    userSelect: "none",
    zIndex: 2,
  },

  chatCol: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.28)",
    backdropFilter: "blur(10px)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },

  agentHeader: {
    padding: 14,
    display: "flex",
    alignItems: "center",
    gap: 12,
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    flex: "0 0 auto",
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: "50%",
    objectFit: "cover",
    objectPosition: "center top",
    border: "2px solid rgba(255,255,255,0.45)",
    backgroundColor: "#000",
    flexShrink: 0,
  },
  avatarFallback: {
    width: 72,
    height: 72,
    borderRadius: "50%",
    border: "2px solid rgba(255,255,255,0.20)",
    background: "rgba(255,255,255,0.06)",
    flexShrink: 0,
  },
  agentMeta: { display: "grid", gap: 6 },
  agentName: {
    fontSize: 18,
    fontWeight: 900,
    color: "#ffffff",
    textShadow: "0 2px 12px rgba(0,0,0,0.60)",
  },
  agentDesc: {
    fontSize: 13,
    fontWeight: 800,
    color: "rgba(238,242,255,0.75)",
    lineHeight: 1.35,
  },

  chatBox: {
    padding: 14,
    overflowY: "auto",
    overflowX: "hidden",
    flex: "1 1 auto",
    minHeight: 0,
  },
  msgRow: {
    display: "flex",
    marginBottom: 10,
  },
  bubble: {
    maxWidth: "78%",
    padding: "10px 12px",
    borderRadius: 14,
    whiteSpace: "pre-wrap",
    lineHeight: 1.35,
    fontWeight: 700,
    fontSize: 13,
    border: "1px solid rgba(255,255,255,0.10)",
  },
  bubbleUser: {
    background: "rgba(255,140,0,0.10)",
    border: "1px solid rgba(255,140,0,0.22)",
  },
  bubbleAgent: {
    background: "rgba(255,255,255,0.06)",
  },

  error: {
    padding: "10px 14px",
    color: "rgba(255,170,170,0.95)",
    fontWeight: 900,
    borderTop: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,0,0,0.06)",
    flex: "0 0 auto",
  },

  inputRow: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    padding: 14,
    borderTop: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.18)",
    flex: "0 0 auto",
  },
  textarea: {
    flex: 1,
    borderRadius: 12,
    padding: "12px 12px",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.35)",
    color: "#fff",
    outline: "none",
    resize: "none",
    minHeight: 44,
    maxHeight: 140,
    fontWeight: 700,
  },
  micBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 900,
    display: "grid",
    placeItems: "center",
  },
  micBtnOn: {
    background: "rgba(255,140,0,0.12)",
    border: "1px solid rgba(255,140,0,0.30)",
  },
  micBtnOff: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
  sendBtn: {
    borderRadius: 12,
    padding: "12px 14px",
    border: "1px solid rgba(255,140,0,0.35)",
    background: "rgba(255,140,0,0.18)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    minWidth: 110,
  },

  center: {
    height: "70vh",
    display: "grid",
    placeItems: "center",
    fontWeight: 900,
    color: "rgba(255,255,255,0.85)",
    position: "relative",
    zIndex: 1,
  },
};
