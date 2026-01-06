import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Chat() {
  const [loading, setLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");

  const [agent, setAgent] = useState(null);
  const [conversationId, setConversationId] = useState(null);

  // Historique / Archives
  const [tab, setTab] = useState("history"); // history | archive
  const [history, setHistory] = useState([]); // 10 dernières
  const [archive, setArchive] = useState([]); // pages de 10
  const [archivePage, setArchivePage] = useState(0);
  const [archiveHasMore, setArchiveHasMore] = useState(true);
  const [archiveLoading, setArchiveLoading] = useState(false);

  const [messages, setMessages] = useState([]);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const threadRef = useRef(null);

  const canSend = useMemo(
    () => input.trim().length > 0 && !sending,
    [input, sending]
  );

  function safeDecode(v) {
    try {
      return decodeURIComponent(v || "");
    } catch {
      return v || "";
    }
  }

  function safeStr(v) {
    return (v ?? "").toString();
  }

  function formatTitleFromFirstUserMessage(text) {
    const t = (text || "").trim().replace(/\s+/g, " ");
    if (!t) return "Nouvelle conversation";
    return t.length > 42 ? t.slice(0, 42) + "…" : t;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = threadRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }

  async function fetchAgent(slug) {
    const { data: a, error } = await supabase
      .from("agents")
      .select("slug, name, description, avatar_url")
      .eq("slug", slug)
      .maybeSingle();
    if (error || !a) return null;
    return a;
  }

  async function fetchConversations({ uid, agentSlug, offset, limit }) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, updated_at")
      .eq("user_id", uid)
      .eq("agent_slug", agentSlug)
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return [];
    return data || [];
  }

  // --- table messages: on essaye conversation_messages puis fallback conversation_message ---
  async function supaSelectMessages(table, uid, convId) {
    return supabase
      .from(table)
      .select("id, role, content, created_at")
      .eq("user_id", uid)
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });
  }

  async function fetchMessages({ uid, convId }) {
    // tentative 1
    let r1 = await supaSelectMessages("conversation_messages", uid, convId);
    if (!r1.error) return r1.data || [];

    // fallback si table not exist
    const msg = safeStr(r1.error?.message).toLowerCase();
    if (msg.includes("could not find the table") || msg.includes("not exist")) {
      const r2 = await supaSelectMessages("conversation_message", uid, convId);
      if (!r2.error) return r2.data || [];
      return [];
    }

    return [];
  }

  async function insertMessage({ uid, convId, role, content }) {
    // tentative 1
    let r1 = await supabase.from("conversation_messages").insert({
      user_id: uid,
      conversation_id: convId,
      role,
      content,
    });

    if (!r1.error) return;

    const msg = safeStr(r1.error?.message).toLowerCase();
    if (msg.includes("could not find the table") || msg.includes("not exist")) {
      await supabase.from("conversation_message").insert({
        user_id: uid,
        conversation_id: convId,
        role,
        content,
      });
    }
  }

  async function createConversation({ uid, agentSlug, title }) {
    const { data, error } = await supabase
      .from("conversations")
      .insert({
        user_id: uid,
        agent_slug: agentSlug,
        title: title || "Nouvelle conversation",
      })
      .select("id")
      .single();

    if (error) return null;
    return data?.id || null;
  }

  async function touchConversation({ uid, convId, titleMaybe }) {
    const patch = { updated_at: new Date().toISOString() };
    if (titleMaybe) patch.title = titleMaybe;

    await supabase
      .from("conversations")
      .update(patch)
      .eq("user_id", uid)
      .eq("id", convId);
  }

  async function refreshHistoryAndArchive(uid, agentSlug) {
    const h = await fetchConversations({ uid, agentSlug, offset: 0, limit: 10 });
    setHistory(h);

    // reset archives
    setArchive([]);
    setArchivePage(0);
    setArchiveHasMore(true);
  }

  async function loadMoreArchive() {
    if (!userId || !agent) return;
    if (archiveLoading || !archiveHasMore) return;

    setArchiveLoading(true);
    try {
      const offset = 10 + archivePage * 10; // tout ce qui est après les 10 derniers
      const rows = await fetchConversations({
        uid: userId,
        agentSlug: agent.slug,
        offset,
        limit: 10,
      });

      if (rows.length === 0) {
        setArchiveHasMore(false);
      } else {
        setArchive((prev) => [...prev, ...rows]);
        setArchivePage((p) => p + 1);
        if (rows.length < 10) setArchiveHasMore(false);
      }
    } finally {
      setArchiveLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;

    async function boot() {
      setErrorMsg("");

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        window.location.href = "/login";
        return;
      }
      if (!mounted) return;

      const uid = session.user.id;
      setUserId(uid);
      setEmail(session.user.email || "");

      const url = new URL(window.location.href);
      const raw = url.searchParams.get("agent");
      const slug = safeDecode(raw).trim().toLowerCase();

      if (!slug) {
        window.location.href = "/agents";
        return;
      }

      const a = await fetchAgent(slug);
      if (!a) {
        alert("Agent introuvable.");
        window.location.href = "/agents";
        return;
      }
      if (!mounted) return;

      setAgent(a);

      const convParam = url.searchParams.get("c");
      const convIdFromUrl = convParam ? safeDecode(convParam).trim() : "";

      await refreshHistoryAndArchive(uid, a.slug);

      let chosenConvId = null;

      // open URL conversation if valid
      if (convIdFromUrl) {
        const msgs = await fetchMessages({ uid, convId: convIdFromUrl });
        if (msgs.length > 0) {
          chosenConvId = convIdFromUrl;
          setConversationId(chosenConvId);
          setMessages(msgs);
          setLoading(false);
          scrollToBottom();
          return;
        }
      }

      // else open latest history
      const h = await fetchConversations({ uid, agentSlug: a.slug, offset: 0, limit: 10 });
      if (!mounted) return;
      setHistory(h);

      if (h && h.length > 0) {
        chosenConvId = h[0].id;
        setConversationId(chosenConvId);

        const msgs = await fetchMessages({ uid, convId: chosenConvId });
        if (!mounted) return;

        if (msgs.length > 0) {
          setMessages(msgs);
        } else {
          setMessages([
            { role: "assistant", content: `Bonjour, je suis ${a.name}. Comment puis-je vous aider ?` },
          ]);
        }

        setLoading(false);
        scrollToBottom();
        return;
      }

      // else create new
      const newConvId = await createConversation({
        uid,
        agentSlug: a.slug,
        title: "Nouvelle conversation",
      });

      if (!mounted) return;

      setConversationId(newConvId);
      setMessages([
        { role: "assistant", content: `Bonjour, je suis ${a.name}. Comment puis-je vous aider ?` },
      ]);

      await refreshHistoryAndArchive(uid, a.slug);

      setLoading(false);
      scrollToBottom();
    }

    boot();

    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!newSession) window.location.href = "/login";
    });

    return () => {
      mounted = false;
      data?.subscription?.unsubscribe?.();
    };
  }, []);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  async function openConversation(convId) {
    if (!userId || !agent || !convId) return;
    setErrorMsg("");
    setConversationId(convId);

    try {
      const url = new URL(window.location.href);
      url.searchParams.set("agent", agent.slug);
      url.searchParams.set("c", convId);
      window.history.replaceState({}, "", url.toString());
    } catch (_) {}

    const msgs = await fetchMessages({ uid: userId, convId });
    setMessages(
      msgs.length > 0
        ? msgs
        : [{ role: "assistant", content: `Bonjour, je suis ${agent.name}. Comment puis-je vous aider ?` }]
    );
    scrollToBottom();
  }

  async function newConversation() {
    if (!userId || !agent) return;
    setErrorMsg("");

    const convId = await createConversation({
      uid: userId,
      agentSlug: agent.slug,
      title: "Nouvelle conversation",
    });

    if (!convId) {
      setErrorMsg("Impossible de créer une conversation.");
      return;
    }

    setConversationId(convId);
    setMessages([
      { role: "assistant", content: `Bonjour, je suis ${agent.name}. Comment puis-je vous aider ?` },
    ]);

    try {
      const url = new URL(window.location.href);
      url.searchParams.set("agent", agent.slug);
      url.searchParams.set("c", convId);
      window.history.replaceState({}, "", url.toString());
    } catch (_) {}

    await refreshHistoryAndArchive(userId, agent.slug);
    scrollToBottom();
  }

  async function sendMessage() {
    if (!agent || !conversationId || !canSend) return;

    const userText = input.trim();
    setInput("");
    setErrorMsg("");

    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setSending(true);
    scrollToBottom();

    await insertMessage({
      uid: userId,
      convId: conversationId,
      role: "user",
      content: userText,
    });

    const isFirstUser = messages.filter((m) => m.role === "user").length === 0;
    const titleMaybe = isFirstUser ? formatTitleFromFirstUserMessage(userText) : null;

    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token || "";
    if (!accessToken) {
      setErrorMsg("Session expirée. Reconnectez-vous.");
      setSending(false);
      return;
    }

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          message: userText,
          agentSlug: agent.slug,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error || "Erreur API");

      const reply = safeStr(data?.reply || "Réponse vide.");

      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      await insertMessage({
        uid: userId,
        convId: conversationId,
        role: "assistant",
        content: reply,
      });

      await touchConversation({ uid: userId, convId: conversationId, titleMaybe });
      await refreshHistoryAndArchive(userId, agent.slug);

      scrollToBottom();
    } catch (e) {
      setErrorMsg(e?.message || "Erreur interne. Réessayez plus tard.");
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Erreur interne. Réessayez plus tard." },
      ]);

      await insertMessage({
        uid: userId,
        convId: conversationId,
        role: "assistant",
        content: "Erreur interne. Réessayez plus tard.",
      });

      await touchConversation({ uid: userId, convId: conversationId, titleMaybe });
      await refreshHistoryAndArchive(userId, agent.slug);
      scrollToBottom();
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

  if (loading || !agent) {
    return (
      <main style={styles.page}>
        <div style={styles.center}>Chargement…</div>
      </main>
    );
  }

  const leftList = tab === "history" ? history : archive;

  return (
    <main style={styles.page}>
      <div style={styles.bg} aria-hidden="true">
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
      </div>

      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <button
            style={styles.backBtn}
            onClick={() => (window.location.href = "/agents")}
          >
            ← Retour
          </button>

          <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.brandLogo} />

          <div style={styles.agentInfo}>
            <div style={styles.agentName}>{agent.name}</div>
            <div style={styles.agentDesc}>{agent.description}</div>
          </div>
        </div>

        <div style={styles.topRight}>
          <span style={styles.userChip}>{email || "Connecté"}</span>
          <button onClick={logout} style={styles.btnGhost}>
            Déconnexion
          </button>
        </div>
      </header>

      <section style={styles.layout}>
        <aside style={styles.sidebar}>
          <div style={styles.sidebarTop}>
            <div style={styles.sidebarTitle}>Conversations</div>
            <button onClick={newConversation} style={styles.newBtn}>
              + Nouvelle
            </button>
          </div>

          <div style={styles.tabs}>
            <button
              type="button"
              onClick={() => setTab("history")}
              style={{ ...styles.tab, ...(tab === "history" ? styles.tabOn : null) }}
            >
              Historique (10)
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("archive");
                if (archive.length === 0 && archiveHasMore) loadMoreArchive();
              }}
              style={{ ...styles.tab, ...(tab === "archive" ? styles.tabOn : null) }}
            >
              Archives
            </button>
          </div>

          <div style={styles.sidebarList}>
            {leftList.length === 0 ? (
              <div style={styles.sidebarEmpty}>
                {tab === "history"
                  ? "Aucune conversation pour cet agent."
                  : "Aucune archive."}
              </div>
            ) : (
              leftList.map((c) => {
                const active = c.id === conversationId;
                return (
                  <button
                    key={c.id}
                    onClick={() => openConversation(c.id)}
                    style={{
                      ...styles.histItem,
                      ...(active ? styles.histItemActive : null),
                    }}
                    title={c.title || "Conversation"}
                  >
                    <div style={styles.histTitle}>{c.title || "Conversation"}</div>
                    <div style={styles.histDate}>
                      {c.updated_at
                        ? new Date(c.updated_at).toLocaleString("fr-FR", {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : ""}
                    </div>
                  </button>
                );
              })
            )}

            {tab === "archive" ? (
              <div style={{ paddingTop: 6 }}>
                {archiveHasMore ? (
                  <button
                    style={styles.loadMore}
                    onClick={loadMoreArchive}
                    disabled={archiveLoading}
                  >
                    {archiveLoading ? "Chargement…" : "Charger plus"}
                  </button>
                ) : (
                  <div style={styles.archiveEnd}>Fin des archives.</div>
                )}
              </div>
            ) : null}
          </div>
        </aside>

        <div style={styles.chatCard}>
          {errorMsg ? <div style={styles.alert}>{errorMsg}</div> : null}

          <div style={styles.thread} ref={threadRef}>
            {messages.map((m, idx) => (
              <div
                key={idx}
                style={{
                  ...styles.bubbleRow,
                  justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    ...styles.bubble,
                    ...(m.role === "user" ? styles.bubbleUser : styles.bubbleBot),
                  }}
                >
                  <div style={styles.role}>
                    {m.role === "user" ? "Vous" : agent.name}
                  </div>
                  <div style={styles.text}>{m.content}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={styles.composer}>
            <textarea
              style={styles.textarea}
              placeholder="Écrivez votre message… (Entrée = envoyer, Maj+Entrée = saut de ligne)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              autoComplete="off"
            />
            <button
              style={canSend ? styles.btn : styles.btnDisabled}
              onClick={sendMessage}
              disabled={!canSend}
            >
              {sending ? "Envoi…" : "Envoyer"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    position: "relative",
    overflow: "hidden",
    fontFamily: "Segoe UI, Arial, sans-serif",
    color: "#eef2ff",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
  },

  bg: { position: "absolute", inset: 0, zIndex: 0 },
  bgLogo: {
    position: "absolute",
    inset: 0,
    backgroundImage: "url('/images/logopc.png')",
    backgroundRepeat: "no-repeat",
    backgroundSize: "contain",
    backgroundPosition: "center",
    opacity: 0.08,
  },
  bgVeils: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(900px 600px at 55% 42%, rgba(255,140,40,.22), rgba(0,0,0,0) 62%)," +
      "radial-gradient(900px 600px at 35% 55%, rgba(80,120,255,.18), rgba(0,0,0,0) 62%)," +
      "linear-gradient(to bottom, rgba(0,0,0,.62), rgba(0,0,0,.22) 30%, rgba(0,0,0,.22) 70%, rgba(0,0,0,.66))",
  },

  topbar: {
    position: "relative",
    zIndex: 2,
    padding: "14px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    background: "rgba(0,0,0,.28)",
    backdropFilter: "blur(10px)",
    borderBottom: "1px solid rgba(255,255,255,.10)",
  },

  topLeft: { display: "flex", alignItems: "center", gap: 12, minWidth: 0 },
  topRight: { display: "flex", alignItems: "center", gap: 10 },

  backBtn: {
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.35)",
    color: "#eef2ff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  brandLogo: { height: 24, width: "auto" },

  agentInfo: { display: "grid", gap: 2, minWidth: 0 },
  agentName: { fontWeight: 900, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  agentDesc: { fontWeight: 800, fontSize: 12, color: "rgba(238,242,255,.72)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },

  userChip: {
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(238,242,255,.85)",
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
    maxWidth: 260,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  btnGhost: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.35)",
    color: "#eef2ff",
    fontWeight: 900,
    cursor: "pointer",
  },

  layout: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gridTemplateColumns: "320px 1fr",
    gap: 14,
    padding: 14,
    height: "calc(100vh - 64px)",
    boxSizing: "border-box",
  },

  sidebar: {
    borderRadius: 22,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.45)",
    backdropFilter: "blur(14px)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },

  sidebarTop: {
    padding: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderBottom: "1px solid rgba(255,255,255,.08)",
    background: "rgba(0,0,0,.18)",
  },

  sidebarTitle: { fontWeight: 900, fontSize: 13 },
  newBtn: {
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.08)",
    color: "#eef2ff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  tabs: {
    display: "flex",
    gap: 8,
    padding: 10,
    borderBottom: "1px solid rgba(255,255,255,.08)",
    background: "rgba(0,0,0,.14)",
  },

  tab: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.20)",
    color: "#eef2ff",
    fontWeight: 900,
    cursor: "pointer",
  },

  tabOn: {
    border: "1px solid rgba(255,140,40,.25)",
    background: "rgba(255,140,40,.10)",
  },

  sidebarList: {
    padding: 10,
    overflowY: "auto",
    display: "grid",
    gap: 10,
    minHeight: 0,
  },

  sidebarEmpty: {
    padding: 12,
    borderRadius: 16,
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.75)",
    fontWeight: 800,
    fontSize: 12,
    lineHeight: 1.35,
  },

  histItem: {
    textAlign: "left",
    width: "100%",
    padding: 12,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.28)",
    color: "#eef2ff",
    cursor: "pointer",
    display: "grid",
    gap: 6,
  },

  histItemActive: {
    background: "linear-gradient(135deg, rgba(255,140,40,.14), rgba(80,120,255,.10))",
    border: "1px solid rgba(255,140,40,.18)",
  },

  histTitle: {
    fontWeight: 900,
    fontSize: 13,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },

  histDate: { fontWeight: 800, fontSize: 11, color: "rgba(238,242,255,.65)" },

  loadMore: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.06)",
    color: "#eef2ff",
    fontWeight: 900,
    cursor: "pointer",
  },

  archiveEnd: {
    padding: 10,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    fontWeight: 800,
    fontSize: 12,
    opacity: 0.8,
    textAlign: "center",
  },

  chatCard: {
    borderRadius: 22,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.55)",
    backdropFilter: "blur(14px)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },

  alert: {
    margin: 12,
    padding: 12,
    borderRadius: 16,
    background: "rgba(255,140,40,.10)",
    border: "1px solid rgba(255,140,40,.18)",
    color: "#eef2ff",
    fontWeight: 900,
    fontSize: 13,
  },

  thread: {
    flex: 1,
    overflowY: "auto",
    padding: 14,
    display: "grid",
    gap: 12,
    minHeight: 0,
  },

  bubbleRow: { display: "flex" },

  bubble: {
    maxWidth: 760,
    borderRadius: 18,
    padding: "12px 14px",
    boxShadow: "0 14px 40px rgba(0,0,0,.35)",
    whiteSpace: "pre-wrap",
    lineHeight: 1.45,
    border: "1px solid rgba(255,255,255,.10)",
  },

  bubbleUser: { background: "rgba(255,255,255,.10)" },
  bubbleBot: { background: "rgba(0,0,0,.35)" },

  role: { fontSize: 11, fontWeight: 900, color: "rgba(238,242,255,.72)", marginBottom: 6 },
  text: { fontSize: 14, fontWeight: 700, color: "rgba(238,242,255,.92)" },

  composer: {
    display: "flex",
    gap: 10,
    padding: 12,
    borderTop: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
  },

  textarea: {
    flex: 1,
    resize: "none",
    padding: "12px 14px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.40)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 800,
    fontSize: 14,
    lineHeight: 1.4,
  },

  btn: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "linear-gradient(135deg, rgba(255,140,40,.18), rgba(80,120,255,.12))",
    color: "#eef2ff",
    fontWeight: 900,
    cursor: "pointer",
    minWidth: 110,
    boxShadow: "0 18px 45px rgba(0,0,0,.45)",
  },

  btnDisabled: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.55)",
    fontWeight: 900,
    cursor: "not-allowed",
    minWidth: 110,
  },

  center: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    fontSize: 20,
    position: "relative",
    zIndex: 1,
  },
};
