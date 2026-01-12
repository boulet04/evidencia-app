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

function buildGreeting(systemPrompt, agentName) {
  const firstName = extractFirstNameFromSystemPrompt(systemPrompt);
  const aName = safeStr(agentName).trim() || "votre agent";

  if (firstName) {
    return `Bonjour ${firstName}, je suis ${aName}, comment puis-je vous aider ?`;
  }
  return `Bonjour, je suis ${aName}, comment puis-je vous aider ?`;
}

export default function AgentChatPage() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const [user, setUser] = useState(null);
  const [agent, setAgent] = useState(null);

  const [systemPrompt, setSystemPrompt] = useState("");
  const [greeting, setGreeting] = useState("");

  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [conversations, setConversations] = useState([]); // [{id, created_at, title}]
  const [deletingConvId, setDeletingConvId] = useState("");

  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const [loadingAgent, setLoadingAgent] = useState(true);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const chatEndRef = useRef(null);

  const title = useMemo(() => {
    return agent?.name ? `Chat — ${agent.name}` : "Chat";
  }, [agent?.name]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      const u = data?.session?.user || null;
      if (!mounted) return;
      setUser(u);

      if (!u) {
        router.replace("/login");
      }
    })().catch(() => {});

    return () => {
      mounted = false;
    };
  }, [router]);

  useEffect(() => {
    if (!user?.id || !agentSlug) return;

    let mounted = true;
    setLoadingAgent(true);

    (async () => {
      // 1) Agent
      const { data: a, error: aErr } = await supabase
        .from("agents")
        .select("id,slug,name,description,avatar_url")
        .eq("slug", agentSlug)
        .maybeSingle();

      if (aErr) throw aErr;
      if (!mounted) return;
      setAgent(a || null);

      // 2) Prompt perso (si existe)
      const { data: cfg } = await supabase
        .from("client_agent_configs")
        .select("system_prompt")
        .eq("user_id", user.id)
        .eq("agent_id", a?.id)
        .maybeSingle();

      const sp = cfg?.system_prompt || "";
      if (!mounted) return;

      setSystemPrompt(sp);
      setGreeting(buildGreeting(sp, a?.name || ""));
    })()
      .catch(() => {
        if (!mounted) return;
        setAgent(null);
        setSystemPrompt("");
        setGreeting(buildGreeting("", ""));
      })
      .finally(() => {
        if (!mounted) return;
        setLoadingAgent(false);
      });

    return () => {
      mounted = false;
    };
  }, [user?.id, agentSlug]);

  useEffect(() => {
    if (!user?.id || !agentSlug) return;

    let mounted = true;
    setLoadingConvs(true);

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id,created_at,title,agent_slug,archived,user_id")
        .eq("user_id", user.id)
        .eq("agent_slug", agentSlug)
        .eq("archived", false)
        .order("created_at", { ascending: false });

      if (error) throw error;
      if (!mounted) return;
      setConversations(data || []);
    })()
      .catch(() => {
        if (!mounted) return;
        setConversations([]);
      })
      .finally(() => {
        if (!mounted) return;
        setLoadingConvs(false);
      });

    return () => {
      mounted = false;
    };
  }, [user?.id, agentSlug]);

  async function loadMessages(convId) {
    if (!convId) {
      setMessages([]);
      return;
    }
    setLoadingMsgs(true);
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("id,role,content,created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      setMessages(data || []);
    } catch {
      setMessages([]);
    } finally {
      setLoadingMsgs(false);
    }
  }

  async function selectConversation(convId) {
    setConversationId(convId);
    await loadMessages(convId);
  }

  async function deleteConversation(convId) {
    if (!convId) return;
    const ok = window.confirm("Supprimer cette conversation ? Cette action est irréversible.");
    if (!ok) return;

    try {
      setDeletingConvId(convId);

      const { data: sData } = await supabase.auth.getSession();
      const token = sData?.session?.access_token || "";
      if (!token) throw new Error("Session expirée. Veuillez vous reconnecter.");

      const r = await fetch("/api/conversations/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ conversationId: convId }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        throw new Error(j?.error || "Suppression impossible.");
      }

      setConversations((prev) => (prev || []).filter((x) => x.id !== convId));

      if (convId === conversationId) {
        setConversationId(null);
        setMessages([]);
      }
    } catch (e) {
      alert((e?.message || "Erreur lors de la suppression.").toString());
    } finally {
      setDeletingConvId("");
    }
  }

  async function newConversation() {
    // Selon votre logique existante : si vous avez déjà /api/conversations/init, utilisez-le.
    // Ici on garde votre logique actuelle (si vous en aviez une dans votre fichier).
    // Si votre version utilise init.js, conservez-la et ne changez rien ici.
    setConversationId(null);
    setMessages([]);
  }

  async function sendMessage() {
    const content = input.trim();
    if (!content || sending) return;

    setSending(true);
    try {
      const { data: sData } = await supabase.auth.getSession();
      const token = sData?.session?.access_token || "";
      if (!token) throw new Error("Session expirée. Veuillez vous reconnecter.");

      // Si pas de conversationId, votre /api/chat crée/associe déjà la conversation (selon votre implémentation).
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          agentSlug,
          conversationId,
          message: content,
        }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) throw new Error(j?.error || "Erreur API");

      // reload conv list si une nouvelle conversation vient d’être créée
      if (j?.conversationId && j.conversationId !== conversationId) {
        setConversationId(j.conversationId);

        // refresh conversations
        const { data: convs } = await supabase
          .from("conversations")
          .select("id,created_at,title,agent_slug,archived,user_id")
          .eq("user_id", user.id)
          .eq("agent_slug", agentSlug)
          .eq("archived", false)
          .order("created_at", { ascending: false });

        setConversations(convs || []);
      }

      setInput("");
      await loadMessages(j?.conversationId || conversationId);
    } catch (e) {
      alert((e?.message || "Erreur d’envoi").toString());
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

  async function logout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  const showGreeting = useMemo(() => {
    // Greeting affiché même si aucune conversation n'est engagée
    // et aussi au démarrage d’une nouvelle conversation.
    // (UI only, pas besoin d’insert DB)
    return !!greeting;
  }, [greeting]);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.backBtn} onClick={() => router.push("/agents")}>
            ← Retour aux agents
          </button>

          <img
            src="/logolong.png"
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

          <div style={styles.userBox}>
            {user?.email ? <span style={styles.userMail}>{user.email}</span> : "Connecté"}
          </div>

          <button style={styles.logoutBtn} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </header>

      <div style={styles.body}>
        {/* SIDEBAR */}
        <aside style={{ ...styles.sidebar, ...(sidebarOpen ? {} : styles.sidebarHidden) }}>
          <div style={styles.sidebarInner}>
            <div style={styles.sidebarTop}>
              <div style={styles.sidebarTitle}>Historique</div>
              <button style={styles.newBtn} onClick={newConversation}>
                + Nouvelle
              </button>
            </div>

            <div style={styles.convList}>
              {loadingConvs ? (
                <div style={styles.muted}>Chargement…</div>
              ) : (conversations || []).length ? (
                (conversations || []).map((c) => {
                  const active = c.id === conversationId;
                  const isDeleting = deletingConvId === c.id;

                  return (
                    <div key={c.id} style={styles.convItemRow}>
                      <button
                        style={{ ...styles.convItemBtn, ...(active ? styles.convItemActive : {}) }}
                        onClick={() => {
                          selectConversation(c.id);
                          setSidebarOpen(false);
                        }}
                        title={c.title || ""}
                        disabled={isDeleting}
                      >
                        <div style={{ fontWeight: 900, fontSize: 13 }}>{c.title || "Conversation"}</div>
                        <div style={styles.tiny}>{new Date(c.created_at).toLocaleString()}</div>
                      </button>

                      <button
                        type="button"
                        style={{ ...styles.convDeleteBtn, ...(isDeleting ? styles.convDeleteBtnDisabled : {}) }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!isDeleting) deleteConversation(c.id);
                        }}
                        title="Supprimer"
                        aria-label="Supprimer la conversation"
                        disabled={isDeleting}
                      >
                        ×
                      </button>
                    </div>
                  );
                })
              ) : (
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
                  <div style={styles.agentName}>{agent?.name || "Agent"}</div>
                  <div style={styles.agentRole}>{agent?.description || ""}</div>
                </div>
              </div>

              {loadingAgent ? (
                <div style={styles.loadingSub}>Chargement de l’agent…</div>
              ) : null}
            </div>

            <div style={styles.chatArea}>
              {showGreeting ? (
                <div style={{ ...styles.bubble, ...styles.bubbleAssistant }}>
                  {greeting}
                </div>
              ) : null}

              {loadingMsgs ? <div style={styles.muted}>Chargement…</div> : null}

              {(messages || []).map((m) => {
                const isUser = m.role === "user";
                return (
                  <div
                    key={m.id}
                    style={{
                      ...styles.bubble,
                      ...(isUser ? styles.bubbleUser : styles.bubbleAssistant),
                    }}
                  >
                    {m.content}
                  </div>
                );
              })}

              <div ref={chatEndRef} />
            </div>

            <div style={styles.composer}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Écrire…"
                style={styles.textarea}
                rows={2}
              />

              <button style={styles.sendBtn} onClick={sendMessage} disabled={sending}>
                Envoyer
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "radial-gradient(1200px 800px at 30% 20%, rgba(255,140,40,.10), transparent 60%), #050505",
    color: "#fff",
  },

  header: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "14px 16px",
    background: "rgba(0,0,0,.55)",
    backdropFilter: "blur(12px)",
    borderBottom: "1px solid rgba(255,255,255,.08)",
  },

  headerLeft: { display: "flex", alignItems: "center", gap: 12, minWidth: 0 },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },

  backBtn: {
    borderRadius: 999,
    padding: "8px 12px",
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.20)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 800,
  },

  headerLogo: { height: 26, width: "auto" },
  headerTitle: { fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },

  headerBtn: {
    borderRadius: 999,
    padding: "8px 12px",
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.20)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 800,
  },

  userBox: {
    borderRadius: 999,
    padding: "8px 12px",
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.20)",
  },
  userMail: { opacity: 0.9, fontWeight: 800, fontSize: 12 },

  logoutBtn: {
    borderRadius: 999,
    padding: "8px 12px",
    border: "1px solid rgba(255,140,40,.25)",
    background: "rgba(255,140,40,.10)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 900,
  },

  body: { display: "grid", gridTemplateColumns: "320px 1fr", gap: 12, padding: 12 },

  sidebar: {
    borderRadius: 18,
    background: "rgba(0,0,0,.28)",
    border: "1px solid rgba(255,255,255,.10)",
    backdropFilter: "blur(14px)",
    overflow: "hidden",
    minHeight: "calc(100vh - 90px)",
  },
  sidebarHidden: { display: "none" },

  sidebarInner: { padding: 12 },

  sidebarTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  sidebarTitle: { fontWeight: 900, fontSize: 14 },

  newBtn: {
    borderRadius: 999,
    padding: "8px 12px",
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.20)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 900,
  },

  convList: {
    display: "grid",
    gap: 10,
    marginTop: 10,
    maxHeight: "calc(100vh - 220px)",
    overflow: "auto",
    paddingRight: 4,
  },

  convItemRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 10,
    alignItems: "center",
  },

  convItemBtn: {
    textAlign: "left",
    borderRadius: 14,
    padding: "12px 12px",
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    color: "#fff",
    cursor: "pointer",
  },

  convDeleteBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    border: "1px solid rgba(255,70,70,.25)",
    background: "rgba(255,70,70,.10)",
    color: "rgba(255,120,120,1)",
    fontWeight: 900,
    fontSize: 18,
    lineHeight: "34px",
    textAlign: "center",
    cursor: "pointer",
  },

  convDeleteBtnDisabled: {
    opacity: 0.55,
    cursor: "not-allowed",
  },

  convItemActive: {
    borderColor: "rgba(255,140,40,.35)",
    background: "rgba(255,140,40,.10)",
  },

  tiny: { marginTop: 6, opacity: 0.7, fontSize: 11, fontWeight: 800 },

  main: { minHeight: "calc(100vh - 90px)" },

  boxChat: {
    borderRadius: 18,
    background: "rgba(0,0,0,.28)",
    border: "1px solid rgba(255,255,255,.10)",
    backdropFilter: "blur(14px)",
    overflow: "hidden",
    minHeight: "calc(100vh - 90px)",
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
  },

  chatTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    padding: 12,
    borderBottom: "1px solid rgba(255,255,255,.08)",
  },

  chatAgent: { display: "flex", alignItems: "center", gap: 10 },

  avatar: { width: 44, height: 44, borderRadius: 999, objectFit: "cover" },
  avatarFallback: { width: 44, height: 44, borderRadius: 999, background: "rgba(255,255,255,.12)" },

  agentName: { fontWeight: 900 },
  agentRole: { opacity: 0.8, fontWeight: 800, fontSize: 12, marginTop: 2 },

  loadingSub: { opacity: 0.75, fontWeight: 800, fontSize: 12 },

  chatArea: { padding: 14, overflow: "auto" },

  bubble: {
    maxWidth: 860,
    padding: "12px 14px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,.08)",
    marginBottom: 10,
    whiteSpace: "pre-wrap",
    lineHeight: 1.35,
    fontWeight: 700,
  },

  bubbleUser: {
    marginLeft: "auto",
    background: "rgba(255,140,40,.12)",
    borderColor: "rgba(255,140,40,.20)",
  },

  bubbleAssistant: {
    marginRight: "auto",
    background: "rgba(0,0,0,.22)",
  },

  muted: { opacity: 0.7, fontWeight: 800, fontSize: 12 },

  composer: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 10,
    padding: 12,
    borderTop: "1px solid rgba(255,255,255,.08)",
  },

  textarea: {
    width: "100%",
    resize: "none",
    borderRadius: 14,
    padding: "12px 12px",
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.20)",
    color: "#fff",
    outline: "none",
    fontWeight: 800,
  },

  sendBtn: {
    borderRadius: 14,
    padding: "0 16px",
    border: "1px solid rgba(255,140,40,.25)",
    background: "rgba(255,140,40,.10)",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 900,
    minWidth: 110,
  },
};
