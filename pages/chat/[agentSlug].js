// pages/chat/[agentSlug].js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

function safeStr(v) {
  return (v ?? "").toString();
}

function extractFirstNameFromSystemPrompt(systemPrompt) {
  const sp = safeStr(systemPrompt);

  // Exemples acceptés :
  // "Tu travailles pour Jean Baptiste"
  // "Tu travailles pour \"Jean Baptiste\""
  // "Tu travailles pour: Jean Baptiste"
  const m = sp.match(/tu\s+travail(?:les)?\s+pour\s*:?\s*"?([^\n\r"]+)"?/i);
  const name = (m?.[1] || "").trim();

  if (!name) return "";
  if (name.length > 40) return "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function buildGreeting(systemPrompt) {
  const firstName = extractFirstNameFromSystemPrompt(systemPrompt);
  return firstName ? `Bonjour ${firstName}, comment puis-je vous aider ?` : "Bonjour, comment puis-je vous aider ?";
}

export default function ChatAgentSlugPage() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const [loading, setLoading] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");

  const [agent, setAgent] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const endRef = useRef(null);

  // Greeting UI (toujours affiché si conversation vide)
  const [systemPromptForGreeting, setSystemPromptForGreeting] = useState("");
  const greetingText = useMemo(() => buildGreeting(systemPromptForGreeting), [systemPromptForGreeting]);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }

  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  function goAdmin() {
    window.location.href = "/admin";
  }

  function goAgents() {
    window.location.href = "/agents";
  }

  async function loadMe() {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      window.location.href = "/login";
      return null;
    }
    setUserId(data.user.id);
    setEmail(data.user.email || "");
    return data.user;
  }

  async function loadAgent(slug) {
    if (!slug) return null;

    const { data, error } = await supabase
      .from("agents")
      .select("id,slug,name,description,avatar_url")
      .eq("slug", slug)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("Agent introuvable.");
    setAgent(data);
    return data;
  }

  async function loadConversations(uid, slug) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id,created_at,title,agent_slug,archived,user_id")
      .eq("user_id", uid)
      .eq("agent_slug", slug)
      .eq("archived", false)
      .order("created_at", { ascending: false });

    if (error) throw error;
    setConversations(data || []);
    return data || [];
  }

  async function createConversation(uid, slug) {
    const title = `Conversation — ${new Date().toLocaleString()}`;

    const { data, error } = await supabase
      .from("conversations")
      .insert({
        user_id: uid,
        agent_slug: slug,
        title,
        archived: false,
      })
      .select("id,created_at,title,agent_slug,archived,user_id")
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async function loadMessages(convId) {
    setLoadingMsgs(true);
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("id,role,content,created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      setMessages(data || []);
      return data || [];
    } finally {
      setLoadingMsgs(false);
    }
  }

  async function fetchUserSystemPromptForAgent(uid, agentId) {
    // Si RLS bloque la lecture, on revient vide (=> greeting générique).
    const { data, error } = await supabase
      .from("client_agent_configs")
      .select("system_prompt")
      .eq("user_id", uid)
      .eq("agent_id", agentId)
      .maybeSingle();

    if (error) return "";
    return safeStr(data?.system_prompt).trim();
  }

  async function primeGreetingPrompt(uid, agentId) {
    if (!uid || !agentId) {
      setSystemPromptForGreeting("");
      return;
    }
    const sp = await fetchUserSystemPromptForAgent(uid, agentId);
    setSystemPromptForGreeting(sp || "");
  }

  async function selectConversation(uid, convId) {
    setConversationId(convId);
    await loadMessages(convId);
    if (agent?.id) {
      await primeGreetingPrompt(uid, agent.id);
    }
  }

  async function refreshAll() {
    setErrMsg("");
    setLoading(true);

    try {
      const slug = safeStr(agentSlug);
      if (!slug) return;

      const me = await loadMe();
      if (!me?.id) return;

      const a = await loadAgent(slug);

      let convs = await loadConversations(me.id, slug);
      let convId = convs?.[0]?.id || null;

      if (!convId) {
        const created = await createConversation(me.id, slug);
        convId = created?.id || null;
        convs = await loadConversations(me.id, slug);
      }

      setConversationId(convId);

      // IMPORTANT : on "prime" le greeting prompt ici
      await primeGreetingPrompt(me.id, a.id);

      if (convId) {
        await loadMessages(convId);
      }
    } catch (e) {
      setErrMsg(e?.message || "Erreur interne.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!router.isReady) return;
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, agentSlug]);

  async function newConversation() {
    try {
      setErrMsg("");
      const slug = safeStr(agentSlug);
      if (!slug) return;

      const me = await supabase.auth.getUser();
      const uid = me?.data?.user?.id;
      if (!uid) return (window.location.href = "/login");

      const created = await createConversation(uid, slug);
      await loadConversations(uid, slug);

      if (created?.id) {
        setConversationId(created.id);

        // Très important : conversation neuve => messages vides
        setMessages([]);

        // On prime le greeting prompt (pour personnaliser)
        if (agent?.id) await primeGreetingPrompt(uid, agent.id);
      }

      setSidebarOpen(false);
    } catch (e) {
      setErrMsg(e?.message || "Erreur création conversation.");
    }
  }

  async function sendMessage() {
    const content = safeStr(text).trim();
    if (!content) return;
    if (!conversationId) return;
    if (!agent?.slug) return;

    setSending(true);
    setErrMsg("");
    setText("");

    try {
      // Message user en DB
      const { data: insertedUser, error: insErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "user",
          content,
        })
        .select("id,role,content,created_at")
        .maybeSingle();

      if (insErr) throw insErr;

      setMessages((prev) => [...prev, insertedUser]);

      // Réponse agent via API
      const token = await getAccessToken();
      if (!token) throw new Error("Non authentifié.");

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          message: content,
          agentSlug: agent.slug,
          conversationId,
        }),
      });

      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(json?.error || `Erreur API (${resp.status})`);

      const reply = safeStr(json?.reply).trim() || "Réponse vide.";

      // Message assistant en DB
      const { data: insertedAsst, error: asstErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "assistant",
          content: reply,
        })
        .select("id,role,content,created_at")
        .maybeSingle();

      if (asstErr) throw asstErr;

      setMessages((prev) => [...prev, insertedAsst]);
    } catch (e) {
      setErrMsg(e?.message || "Erreur interne.");
    } finally {
      setSending(false);
    }
  }

  const title = useMemo(() => {
    if (!agent) return "Chat";
    return agent.name ? `${agent.name} — Chat` : "Chat";
  }, [agent]);

  // Greet visible only if conversation has zero persisted messages
  const showGreeting = useMemo(() => {
    if (loading || loadingMsgs) return false;
    return (messages?.length || 0) === 0;
  }, [loading, loadingMsgs, messages?.length]);

  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.center}>
          <div style={styles.loadingCard}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>Chargement…</div>
            <div style={styles.loadingSub}>Initialisation de la conversation</div>
            {!!errMsg && <div style={styles.alert}>{errMsg}</div>}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.headerBtn} onClick={goAgents} title="Retour agents">
            ← Retour
          </button>

          <img
            src="/images/logolong.png"
            alt="Evidenc'IA"
            style={styles.headerLogo}
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />

          <div style={styles.headerTitle}>{title}</div>
        </div>

        <div style={styles.headerRight}>
          <button style={styles.headerBtn} onClick={() => setSidebarOpen((v) => !v)}>
            Historique
          </button>

          <button style={styles.headerBtn} onClick={goAdmin}>
            Admin
          </button>

          <button style={styles.headerBtnDanger} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </div>

      <div style={styles.wrap}>
        <aside style={styles.sidebar}>
          <div style={styles.box}>
            <div style={styles.sideTop}>
              <div style={styles.boxTitle}>Conversations</div>
              <button style={styles.newBtn} onClick={newConversation}>
                + Nouvelle
              </button>
            </div>

            <div style={styles.small}>
              {email ? (
                <>
                  <span style={{ opacity: 0.9 }}>Connecté :</span> {email}
                </>
              ) : (
                "Connecté"
              )}
            </div>

            <div style={{ height: 10 }} />

            <div style={styles.convList}>
              {(conversations || []).map((c) => {
                const active = c.id === conversationId;
                return (
                  <button
                    key={c.id}
                    style={{ ...styles.convItem, ...(active ? styles.convItemActive : {}) }}
                    onClick={() => {
                      selectConversation(userId, c.id);
                    }}
                    title={c.title || ""}
                  >
                    <div style={{ fontWeight: 900, fontSize: 13 }}>{c.title || "Conversation"}</div>
                    <div style={styles.tiny}>{new Date(c.created_at).toLocaleString()}</div>
                  </button>
                );
              })}
              {conversations.length === 0 && <div style={styles.muted}>Aucune conversation.</div>}
            </div>
          </div>
        </aside>

        <section style={styles.main}>
          <div style={styles.boxChat}>
            <div style={styles.chatTop}>
              <div style={styles.chatAgent}>
                {agent?.avatar_url ? (
                  <img src={agent.avatar_url} alt={agent.name} style={styles.avatar} />
                ) : (
                  <div style={styles.avatarFallback} />
                )}
                <div>
                  <div style={{ fontWeight: 900 }}>{agent?.name || agent?.slug}</div>
                  <div style={styles.small}>{agent?.description || agent?.slug}</div>
                </div>
              </div>

              <div style={styles.diag}>
                <div>
                  <b>Conv</b>: {conversationId ? "oui" : "non"}
                </div>
                <div>
                  <b>Msgs</b>: {messages.length}
                </div>
              </div>
            </div>

            <div style={styles.chatBody}>
              {loadingMsgs ? (
                <div style={styles.muted}>Chargement des messages…</div>
              ) : (
                <div style={styles.msgList}>
                  {/* Greeting UI (toujours affiché si conversation vide) */}
                  {showGreeting && (
                    <div style={{ ...styles.msgRow, justifyContent: "flex-start" }}>
                      <div style={{ ...styles.bubble, ...styles.bubbleAsst }}>
                        <div style={styles.bubbleText}>{greetingText}</div>
                        <div style={styles.bubbleMeta}>{new Date().toLocaleTimeString()}</div>
                      </div>
                    </div>
                  )}

                  {messages.map((m) => {
                    const isUser = m.role === "user";
                    return (
                      <div key={m.id} style={{ ...styles.msgRow, justifyContent: isUser ? "flex-end" : "flex-start" }}>
                        <div style={{ ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleAsst) }}>
                          <div style={styles.bubbleText}>{m.content}</div>
                          <div style={styles.bubbleMeta}>{new Date(m.created_at).toLocaleTimeString()}</div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={endRef} />
                </div>
              )}
            </div>

            {!!errMsg && <div style={styles.alert}>{errMsg}</div>}

            <div style={styles.composer}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Écrivez votre message…"
                style={styles.textarea}
                disabled={sending}
              />

              <div style={styles.composerActions}>
                <button style={!sending ? styles.btnPrimary : styles.btnDisabled} onClick={sendMessage} disabled={sending}>
                  {sending ? "Envoi…" : "Envoyer"}
                </button>
              </div>
            </div>

            <div style={styles.tiny}>
              La phrase d’accueil est affichée automatiquement quand la conversation est vide (sans dépendre de la base).
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "rgba(238,242,255,.92)",
    fontFamily: '"Segoe UI", Arial, sans-serif',
  },

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "14px 16px 0",
    flexWrap: "wrap",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12, minWidth: 280 },
  headerRight: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  headerLogo: { height: 26, width: "auto", opacity: 0.95, display: "block" },
  headerTitle: { fontWeight: 900, opacity: 0.9 },

  headerBtn: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.25)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  headerBtnDanger: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  wrap: {
    display: "grid",
    gridTemplateColumns: "360px 1fr",
    gap: 16,
    padding: 18,
  },

  sidebar: { position: "relative", zIndex: 2 },

  box: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
  },

  boxChat: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
    display: "grid",
    gap: 12,
  },

  boxTitle: { fontWeight: 900, marginBottom: 6 },

  sideTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 8,
  },

  newBtn: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  convList: {
    display: "grid",
    gap: 10,
    marginTop: 10,
    maxHeight: "calc(100vh - 220px)",
    overflow: "auto",
    paddingRight: 4,
  },

  convItem: {
    textAlign: "left",
    borderRadius: 14,
    padding: 12,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    color: "rgba(238,242,255,.92)",
    cursor: "pointer",
  },
  convItemActive: {
    borderColor: "rgba(255,140,40,.35)",
    background: "rgba(255,140,40,.10)",
  },

  chatTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },

  chatAgent: { display: "flex", alignItems: "center", gap: 12 },

  avatar: {
    width: 46,
    height: 46,
    borderRadius: 999,
    objectFit: "cover",
    border: "1px solid rgba(255,255,255,.16)",
    background: "rgba(255,255,255,.05)",
  },
  avatarFallback: {
    width: 46,
    height: 46,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.16)",
    background: "rgba(255,255,255,.06)",
  },

  diag: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    fontSize: 12,
    fontWeight: 800,
    opacity: 0.9,
  },

  chatBody: {
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    padding: 12,
    minHeight: "52vh",
    maxHeight: "58vh",
    overflow: "auto",
  },

  msgList: { display: "grid", gap: 12 },
  msgRow: { display: "flex" },

  bubble: {
    maxWidth: "min(720px, 92%)",
    borderRadius: 16,
    padding: 12,
    border: "1px solid rgba(255,255,255,.12)",
    boxShadow: "0 14px 40px rgba(0,0,0,.35)",
  },
  bubbleUser: {
    background: "rgba(80,120,255,.10)",
    borderColor: "rgba(80,120,255,.30)",
  },
  bubbleAsst: {
    background: "rgba(0,0,0,.18)",
  },

  bubbleText: {
    whiteSpace: "pre-wrap",
    lineHeight: 1.35,
    fontWeight: 700,
  },
  bubbleMeta: {
    marginTop: 8,
    fontSize: 11,
    opacity: 0.7,
    fontWeight: 800,
    textAlign: "right",
  },

  composer: { display: "grid", gap: 10 },

  textarea: {
    width: "100%",
    minHeight: 80,
    resize: "vertical",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    padding: 12,
    outline: "none",
    fontFamily: '"Segoe UI", Arial, sans-serif',
    fontSize: 14,
    fontWeight: 700,
  },

  composerActions: { display: "flex", justifyContent: "flex-end", gap: 10 },

  btnPrimary: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    minWidth: 110,
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

  small: { fontSize: 12, opacity: 0.75, fontWeight: 800 },
  tiny: { fontSize: 11, opacity: 0.7, fontWeight: 800 },
  muted: { opacity: 0.75, fontWeight: 800, fontSize: 13 },

  alert: {
    marginTop: 6,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    fontWeight: 900,
  },

  center: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
  },

  loadingCard: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 26,
    padding: 24,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.60)",
    backdropFilter: "blur(14px)",
    border: "1px solid rgba(255,255,255,.12)",
  },

  loadingSub: {
    marginTop: 6,
    color: "rgba(255,255,255,.78)",
    fontWeight: 800,
    fontSize: 12,
  },
};
