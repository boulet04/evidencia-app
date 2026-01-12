// pages/chat.js
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function ChatPage() {
  // --- Session / user ---
  const [sessionEmail, setSessionEmail] = useState("");
  const [userId, setUserId] = useState("");

  // --- Agent ---
  const [agentSlug, setAgentSlug] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentDesc, setAgentDesc] = useState("");
  const [agentAvatar, setAgentAvatar] = useState("");

  // --- UI state ---
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // --- Conversations / messages ---
  const [conversations, setConversations] = useState([]);
  const [selectedConvId, setSelectedConvId] = useState("");
  const [messages, setMessages] = useState([]);

  // --- Input ---
  const [input, setInput] = useState("");
  const endRef = useRef(null);

  // --- Micro / dictée (Web Speech API) ---
  const recognitionRef = useRef(null);
  const finalTextRef = useRef("");
  const [micSupported, setMicSupported] = useState(false);
  const [listening, setListening] = useState(false);

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

  // Auto-scroll
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Init speech recognition support
  useEffect(() => {
    const SR =
      typeof window !== "undefined"
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;

    setMicSupported(Boolean(SR));
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
    } catch (_) {
      // Non bloquant
    }
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
      // Ne pas afficher les messages techniques
      if (m.role === "system") return false;
      if ((m.content || "").startsWith("MEMORY:")) return false;
      if ((m.content || "").startsWith("PENDING_EMAIL:")) return false;
      return true;
    });

    setMessages(list);
    return list;
  }

  async function createConversationNow(initialTitle = DEFAULT_TITLE) {
    if (!userId || !agentSlug) return "";

    // Try with archived (si colonne existe)
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

    // Fallback sans archived
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

    // Si la conv a été créée "vide", on la renomme au 1er message
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
      .limit(10);

    if (error) {
      const { data: data2, error: error2 } = await supabase
        .from("conversations")
        .select("id, created_at, title, agent_slug, user_id")
        .eq("user_id", uid)
        .eq("agent_slug", slug)
        .order("created_at", { ascending: false })
        .limit(10);

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
    // Si aucune conversation, on en crée une immédiatement + greeting
    const { list, firstId } = await refreshConversations(userId, agentSlug);

    if (firstId) {
      setSelectedConvId(firstId);
      await loadMessages(firstId);
      return;
    }

    // Aucune conversation => on crée + greeting + on charge
    const convId = await createConversationNow(DEFAULT_TITLE);
    if (!convId) {
      setSelectedConvId("");
      setMessages([]);
      return;
    }

    await refreshConversations(userId, agentSlug);
    setSelectedConvId(convId);

    // IMPORTANT : greeting avant toute action user
    await initGreetingIfEmpty(convId);
    await loadMessages(convId);
  }

  // Init page: session + agent + conversations
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

  // Une fois userId + agentSlug connus : on garantit une conversation existante + greeting
  useEffect(() => {
    if (!userId || !agentSlug) return;
    (async () => {
      setErrorMsg("");
      await ensureConversationExistsWithGreeting();
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

    // Greeting doit s’afficher immédiatement
    await initGreetingIfEmpty(convId);
    await loadMessages(convId);
  }

  async function sendMessage() {
    if (!input.trim() || sending) return;
    setErrorMsg("");
    setSending(true);

    try {
      let convId = selectedConvId;

      // Si aucune conv sélectionnée (cas rare), on en crée tout de suite + greeting, puis on envoie
      if (!convId) {
        convId = await createConversationNow(DEFAULT_TITLE);
        if (!convId) {
          setErrorMsg("Impossible de créer une conversation.");
          setSending(false);
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
        return;
      }

      const userText = input.trim();
      setInput("");

      // Optimistic UI (après greeting)
      setMessages((prev) => [
        ...(prev || []),
        { id: "tmp-" + Date.now(), role: "user", content: userText, created_at: new Date().toISOString() },
      ]);

      // Renommer la conversation au 1er message (si elle était "Nouvelle conversation")
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
        return;
      }

      if (json?.conversationId && json.conversationId !== convId) {
        convId = json.conversationId;
        setSelectedConvId(convId);
      }

      await loadMessages(convId);
      setSending(false);
    } catch (_) {
      setErrorMsg("Erreur lors de l’envoi.");
      setSending(false);
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

      <div style={styles.shell}>
        <aside style={styles.sidebar}>
          <div style={styles.sideTop}>
            <div style={styles.sideTitle}>Historique</div>
            <button style={styles.newBtn} onClick={handleNewConversation} title="Nouvelle conversation">
              + Nouvelle
            </button>
          </div>

          <div style={styles.convList}>
            {(conversations || []).map((c) => (
              <button
                key={c.id}
                style={{
                  ...styles.convItem,
                  ...(selectedConvId === c.id ? styles.convItemActive : {}),
                }}
                onClick={async () => {
                  setSelectedConvId(c.id);
                  await loadMessages(c.id);
                }}
                title={c.title || ""}
              >
                <div style={styles.convTitle}>{c.title || "Conversation"}</div>
                <div style={styles.convMeta}>
                  {c.created_at ? new Date(c.created_at).toLocaleString("fr-FR") : ""}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section style={styles.chatCol}>
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

            <button onClick={sendMessage} disabled={sending || !input.trim()} style={styles.sendBtn}>
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
    minWidth: 0,
  },
  topLeft: { display: "flex", alignItems: "center", gap: 12, minWidth: 0 },
  topCenter: { display: "flex", justifyContent: "center", alignItems: "center", minWidth: 0 },
  topRight: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, minWidth: 0 },

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
    minWidth: 0,
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
    gridTemplateColumns: "320px minmax(0, 1fr)", // minmax(0,1fr) empêche les débordements/coupures en grid
    gap: 14,
    padding: 14,
    flex: "1 1 auto",
    minHeight: 0,
    overflow: "hidden",
    minWidth: 0,
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
    minWidth: 0,
  },
  sideTop: {
    padding: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    flex: "0 0 auto",
    minWidth: 0,
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

  // IMPORTANT : anti-coupure liée à scrollbar / grid
  convList: {
    padding: 10,
    paddingRight: 14, // évite que la scrollbar rogne visuellement le contenu
    display: "grid",
    gap: 8,
    overflowY: "auto",
    overflowX: "hidden",
    flex: "1 1 auto",
    minHeight: 0,
    minWidth: 0,
    scrollbarGutter: "stable",
  },

  // IMPORTANT : minWidth:0 + boxSizing pour que le texte ne soit plus tronqué anormalement
  convItem: {
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    display: "block",
    textAlign: "left",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.26)",
    color: "#fff",
    padding: 10,
    cursor: "pointer",
    overflow: "hidden",
  },

  convItemActive: {
    border: "1px solid rgba(255,140,0,0.42)",
    background: "rgba(255,140,0,0.08)",
  },

  // Titre sur 2 lignes max (clamp) au lieu d’une coupe sèche
  convTitle: {
    width: "100%",
    minWidth: 0,
    fontSize: 12,
    fontWeight: 900,
    marginBottom: 4,
    overflow: "hidden",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  },

  convMeta: {
    width: "100%",
    minWidth: 0,
    fontSize: 11,
    fontWeight: 700,
    color: "rgba(238,242,255,0.60)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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
    minWidth: 0,
  },

  agentHeader: {
    padding: 14,
    display: "flex",
    alignItems: "center",
    gap: 12,
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    flex: "0 0 auto",
    minWidth: 0,
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
  agentMeta: { display: "grid", gap: 6, minWidth: 0 },
  agentName: {
    fontSize: 18,
    fontWeight: 900,
    color: "#ffffff",
    textShadow: "0 2px 12px rgba(0,0,0,0.60)",
    minWidth: 0,
  },
  agentDesc: {
    fontSize: 13,
    fontWeight: 800,
    color: "rgba(238,242,255,0.75)",
    lineHeight: 1.35,
    minWidth: 0,
  },

  chatBox: {
    padding: 14,
    overflowY: "auto",
    overflowX: "hidden",
    flex: "1 1 auto",
    minHeight: 0,
    minWidth: 0,
  },
  msgRow: {
    display: "flex",
    marginBottom: 10,
    minWidth: 0,
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
    minWidth: 0,
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
    minWidth: 0,
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
    flex: "0 0 auto",
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
    flex: "0 0 auto",
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
