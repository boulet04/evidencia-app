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

  function safeStr(v) {
    return (v ?? "").toString();
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

  // Init speech recognition
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

  // Read agent from URL: /chat?agent=emma
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

        // Load agent details
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

        // Load conversations
        await refreshConversations(user.id, slug);

        setLoading(false);
      } catch (e) {
        setErrorMsg("Erreur initialisation chat.");
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshConversations(uid, slug) {
    // 10 dernières conversations
    const { data, error } = await supabase
      .from("conversations")
      .select("id, created_at, title, archived, agent_slug, user_id")
      .eq("user_id", uid)
      .eq("agent_slug", slug)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      // fallback sans archived si colonne absente
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
        return;
      }

      setConversations(data2 || []);
      const firstId = data2?.[0]?.id || "";
      setSelectedConvId(firstId);
      if (firstId) await loadMessages(firstId, true);
      else setMessages([]);
      return;
    }

    const filtered = (data || []).filter((c) => c.archived !== true);
    setConversations(filtered);

    const firstId = filtered?.[0]?.id || "";
    setSelectedConvId(firstId);

    if (firstId) await loadMessages(firstId, true);
    else setMessages([]);
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

  async function loadMessages(conversationId, allowInit = false) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error) {
      setErrorMsg("Impossible de charger les messages.");
      setMessages([]);
      return;
    }

    const list = data || [];
    setMessages(list);

    // Si conversation vide, on injecte un message d'accueil (persisté) via /api/conversations/init
    if (allowInit && list.length === 0) {
      await initGreetingIfEmpty(conversationId);
      // recharger après init
      const { data: data2 } = await supabase
        .from("messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      setMessages(data2 || []);
    }
  }

  async function createNewConversation() {
    if (!userId || !agentSlug) return "";

    const title = input?.trim()
      ? input.trim().slice(0, 60) + (input.trim().length > 60 ? "…" : "")
      : "Nouvelle conversation";

    // Try with archived
    const { data, error } = await supabase
      .from("conversations")
      .insert({
        user_id: userId,
        agent_slug: agentSlug,
        title,
        archived: false,
      })
      .select("id")
      .single();

    if (!error && data?.id) return data.id;

    // Fallback without archived
    const { data: data2, error: error2 } = await supabase
      .from("conversations")
      .insert({
        user_id: userId,
        agent_slug: agentSlug,
        title,
      })
      .select("id")
      .single();

    if (error2 || !data2?.id) return "";
    return data2.id;
  }

  async function sendMessage() {
    if (!input.trim() || sending) return;
    setErrorMsg("");
    setSending(true);

    try {
      let convId = selectedConvId;

      if (!convId) {
        convId = await createNewConversation();
        if (!convId) {
          setErrorMsg("Impossible de créer une conversation.");
          setSending(false);
          return;
        }
        setSelectedConvId(convId);
        await refreshConversations(userId, agentSlug);
        // message d'accueil si vide
        await loadMessages(convId, true);
      }

      const token = await getAccessToken();
      if (!token) {
        setErrorMsg("Session expirée. Reconnectez-vous.");
        setSending(false);
        return;
      }

      // Optimistic UI
      setMessages((prev) => [
        ...(prev || []),
        { id: "tmp-" + Date.now(), role: "user", content: input.trim(), created_at: new Date().toISOString() },
      ]);

      const payload = {
        agentSlug,
        conversationId: convId,
        message: input.trim(),
      };

      setInput("");

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const json = await resp.json().catch(() => null);

      if (!resp.ok) {
        setErrorMsg(json?.error || "Erreur lors de l’envoi.");
        await loadMessages(convId, false);
        setSending(false);
        return;
      }

      if (json?.conversationId && json.conversationId !== convId) {
        setSelectedConvId(json.conversationId);
        convId = json.conversationId;
      }

      await loadMessages(convId, false);
      setSending(false);
    } catch (e) {
      setErrorMsg("Erreur lors de l’envoi.");
      setSending(false);
    }
  }

  const headerRightLabel = useMemo(() => {
    if (!sessionEmail) return "";
    return sessionEmail;
  }, [sessionEmail]);

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

      {/* TOP BAR */}
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

      {/* BODY */}
      <div style={styles.shell}>
        {/* LEFT: history */}
        <aside style={styles.sidebar}>
          <div style={styles.sideTop}>
            <div style={styles.sideTitle}>Historique</div>
            <button
              style={styles.newBtn}
              onClick={async () => {
                setSelectedConvId("");
                setMessages([]);
                setErrorMsg("");
              }}
              title="Nouvelle conversation"
            >
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
                  await loadMessages(c.id, true);
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

        {/* RIGHT: chat */}
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

          {/* INPUT */}
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

            {/* Micro button (SVG) */}
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
      <rect
        x="7"
        y="7"
        width="10"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
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
    minHeight: 0, // CRUCIAL pour éviter l’historique coupé
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
    minHeight: 0, // CRUCIAL
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
    gap: 8,
    overflowY: "auto",
    overflowX: "hidden",
    flex: "1 1 auto",
    minHeight: 0, // CRUCIAL
  },
  convItem: {
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
  convTitle: {
    fontSize: 12,
    fontWeight: 900,
    marginBottom: 4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  convMeta: {
    fontSize: 11,
    fontWeight: 700,
    color: "rgba(238,242,255,0.60)",
  },

  chatCol: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.28)",
    backdropFilter: "blur(10px)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    minHeight: 0, // CRUCIAL
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
