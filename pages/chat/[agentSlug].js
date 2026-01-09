// pages/chat/[agentSlug].js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

function safeStr(v) {
  return (v ?? "").toString();
}

function extractFirstNameFromSystemPrompt(systemPrompt) {
  const sp = safeStr(systemPrompt);

  // Tolère :
  // - tu travail pour Chloé
  // - tu travailles pour "Chloé"
  // - Tu travailles pour: Chloé
  // - tu travaille pour prénom de la personne
  const m = sp.match(/tu\s+travail(?:les)?\s+pour\s*:?\s*"?([^"\n\r]+)"?/i);
  const name = (m?.[1] || "").trim();

  if (!name) return "";
  if (name.length > 40) return ""; // garde-fou
  // Capitalisation simple
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function buildGreeting(systemPrompt) {
  const firstName = extractFirstNameFromSystemPrompt(systemPrompt);
  return firstName
    ? `Bonjour ${firstName}, comment puis-je vous aider ?`
    : "Bonjour, comment puis-je vous aider ?";
}

export default function ChatAgentSlugPage() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const [loading, setLoading] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");

  const [agent, setAgent] = useState(null); // { id, slug, name, description, avatar_url }
  const [conversations, setConversations] = useState([]); // [{id, created_at, title}]
  const [conversationId, setConversationId] = useState(null);

  const [messages, setMessages] = useState([]); // [{id, role, content, created_at}]
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  // Mobile sidebar (historique)
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const endRef = useRef(null);

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

  async function goAdmin() {
    window.location.href = "/admin";
  }

  async function goAgents() {
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

  async function loadConversations(slug) {
    // conversations stockent agent_slug dans ton schéma
    const { data, error } = await supabase
      .from("conversations")
      .select("id,created_at,title,agent_slug,archived")
      .eq("agent_slug", slug)
      .eq("archived", false)
      .order("created_at", { ascending: false });

    if (error) throw error;
    setConversations(data || []);
    return data || [];
  }

  async function createConversation(slug) {
    const title = `Conversation — ${new Date().toLocaleString()}`;
    const { data, error } = await supabase
      .from("conversations")
      .insert({
        agent_slug: slug,
        title,
        archived: false,
      })
      .select("id,created_at,title,agent_slug,archived")
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

  async function fetchUserSystemPromptForAgent(agentId) {
    // Récupère system_prompt dans client_agent_configs (si RLS OK).
    // Sinon, fallback vide => greeting générique.
    const { data, error } = await supabase
      .from("client_agent_configs")
      .select("system_prompt")
      .eq("user_id", userId)
      .eq("agent_id", agentId)
      .maybeSingle();

    if (error) {
      // RLS ou autre : on n’empêche pas l’app, on fallback.
      return "";
    }
    return safeStr(data?.system_prompt).trim();
  }

  async function ensureGreetingIfEmpty(convId, agentId) {
    // 1) relire messages (source de vérité)
    const current = await loadMessages(convId);
    if (current.length > 0) return;

    // 2) calcul greeting (avec prénom si trouvable)
    const sp = await fetchUserSystemPromptForAgent(agentId);
    const greeting = buildGreeting(sp);

    // 3) insert en DB
    const { data, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: convId,
        role: "assistant",
        content: greeting,
      })
      .select("id,role,content,created_at")
      .maybeSingle();

    if (!error && data) {
      setMessages([data]);
    } else {
      // fallback UI si insert refusée (RLS), sans casser
      setMessages([
        {
          id: "local-greeting",
          role: "assistant",
          content: greeting,
          created_at: new Date().toISOString(),
        },
      ]);
    }
  }

  async function selectConversation(convId) {
    setConversationId(convId);
    await loadMessages(convId);
    if (agent?.id) {
      await ensureGreetingIfEmpty(convId, agent.id);
    }
  }

  async function refreshAll() {
    setErrMsg("");
    setLoading(true);
    try {
      const slug = safeStr(agentSlug);
      if (!slug) return;

      await loadMe();
      const a = await loadAgent(slug);

      const convs = await loadConversations(slug);

      // Conversation par défaut :
      // - si déjà une conversation, prendre la première
      // - sinon créer une nouvelle conversation
      let convId = convs?.[0]?.id || null;
      if (!convId) {
        const created = await createConversation(slug);
        convId = created?.id || null;
        // recharge la liste pour inclure la nouvelle
        await loadConversations(slug);
      }

      setConversationId(convId);

      if (convId) {
        await loadMessages(convId);
        await ensureGreetingIfEmpty(convId, a.id);
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

      const created = await createConversation(slug);
      await loadConversations(slug);

      if (created?.id) {
        setConversationId(created.id);
        // On force greeting
        if (agent?.id) {
          await ensureGreetingIfEmpty(created.id, agent.id);
        } else {
          await loadMessages(created.id);
        }
      }

      // Mobile : referme l’historique
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
      // 1) insert user message
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

      // 2) call API (Mistral) + conversationId pour historique côté serveur
      const token = await getAccessToken();
      if (!token) throw new Error("Non authentifié.");

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: content,
          agentSlug: agent.slug,
          conversationId,
        }),
      });

      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(json?.error || `Erreur API (${resp.status})`);
      }

      const reply = safeStr(json?.reply).trim() || "Réponse vide.";

      // 3) insert assistant reply
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

      // 4) optionnel : mettre à jour le titre si vide
      // (non bloquant)
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

  const sidebarStyle = useMemo(() => {
    if (!styles.sidebarBase) return {};
    if (!sidebarOpen) return styles.sidebarBase;
    return { ...styles.sidebarBase, ...styles.sidebarMobileOpen };
  }, [sidebarOpen]);

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
        {/* SIDEBAR */}
        <aside style={sidebarStyle}>
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
                      selectConversation(c.id);
                      setSidebarOpen(false);
                    }}
                    title={c.title || ""}
                  >
                    <div style={{ fontWeight: 900, fontSize: 13 }}>
                      {c.title || "Conversation"}
                    </div>
                    <div style={styles.tiny}>
                      {new Date(c.created_at).toLocaleString()}
                    </div>
                  </button>
                );
              })}
              {conversations.length === 0 && (
                <div style={styles.muted}>Aucune conversation.</div>
              )}
            </div>
          </div>
        </aside>

        {/* CHAT */}
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
                  {messages.map((m) => {
                    const isUser = m.role === "user";
                    return (
                      <div key={m.id} style={{ ...styles.msgRow, justifyContent: isUser ? "flex-end" : "flex-start" }}>
                        <div style={{ ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleAsst) }}>
                          <div style={styles.bubbleText}>{m.content}</div>
                          <div style={styles.bubbleMeta}>
                            {new Date(m.created_at).toLocaleTimeString()}
                          </div>
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
                <button
                  style={!sending ? styles.btnPrimary : styles.btnDisabled}
                  onClick={sendMessage}
                  disabled={sending}
                >
                  {sending ? "Envoi…" : "Envoyer"}
                </button>
              </div>
            </div>

            <div style={styles.tiny}>
              Astuce : le message d’accueil est inséré automatiquement uniquement si la conversation est vide.
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

  // Sidebar responsive
  sidebarBase: {
    position: "relative",
    zIndex: 2,
  },
  sidebarMobileOpen: {
    // Sur mobile, on passera en overlay via media (ci-dessous),
    // mais on garde un style safe si nécessaire.
  },

  left: {},
  main: {},

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

  composer: {
    display: "grid",
    gap: 10,
  },

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

  composerActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
  },

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
    position: "relative",
    zIndex: 1,
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
