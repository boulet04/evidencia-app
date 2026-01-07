import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";
import AgentBubble from "../../components/AgentBubble";

export default function AgentChat() {
  const router = useRouter();
  const { slug } = router.query;

  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);

  const [agent, setAgent] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [activeConvId, setActiveConvId] = useState("");

  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const agentAvatar = useMemo(() => {
    if (!agent) return "";
    return agent.avatar_url || `/images/${agent.slug}.png`;
  }, [agent]);

  function fmtDate(ts) {
    try {
      const d = new Date(ts);
      const dd = d.toLocaleDateString("fr-FR");
      const hh = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      return `${dd} ${hh}`;
    } catch {
      return "";
    }
  }

  async function loadAll(session) {
    setErr("");

    // profil
    const { data: myP } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", session.user.id)
      .maybeSingle();

    setMe({
      ...myP,
      email: myP?.email || session.user.email || null,
    });

    // agent
    const { data: ag, error: agErr } = await supabase
      .from("agents")
      .select("id, slug, name, description, avatar_url")
      .eq("slug", slug)
      .maybeSingle();

    if (agErr) throw agErr;
    if (!ag) throw new Error("Agent introuvable.");

    setAgent(ag);

    // convs
    const { data: convs, error: cErr } = await supabase
      .from("conversations")
      .select("id, user_id, agent_slug, title, created_at")
      .eq("user_id", session.user.id)
      .eq("agent_slug", slug)
      .order("created_at", { ascending: false });

    if (cErr) throw cErr;

    const list = convs || [];
    setConversations(list);

    // active conv
    const firstId = list[0]?.id || "";
    setActiveConvId(firstId);

    // messages
    if (firstId) {
      await loadMessages(firstId);
    } else {
      setMessages([]);
    }
  }

  async function loadMessages(conversationId) {
    const { data: msgs, error: mErr } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (mErr) throw mErr;
    setMessages(msgs || []);
  }

  useEffect(() => {
    let mounted = true;

    async function boot() {
      try {
        setLoading(true);

        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session) {
          router.replace("/login");
          return;
        }

        if (!slug) return;

        await loadAll(session);
        if (!mounted) return;
      } catch (e) {
        if (!mounted) return;
        setErr(e?.message || "Erreur de chargement.");
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    }

    boot();
    return () => {
      mounted = false;
    };
  }, [slug]);

  async function logout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  async function createConversation() {
    if (!slug) return;
    setErr("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      const { data, error } = await supabase
        .from("conversations")
        .insert({
          user_id: session.user.id,
          agent_slug: slug,
          title: "Nouvelle conversation",
        })
        .select("id, user_id, agent_slug, title, created_at")
        .single();

      if (error) throw error;

      setConversations((prev) => [data, ...prev]);
      setActiveConvId(data.id);
      setMessages([]);

      // message d’accueil (assistant) optionnel
      const greeting = agent?.name
        ? `Bonjour, je suis ${agent.name}. Comment puis-je vous aider ?`
        : "Bonjour. Comment puis-je vous aider ?";

      const { error: mErr } = await supabase.from("messages").insert({
        conversation_id: data.id,
        role: "assistant",
        content: greeting,
      });
      if (mErr) {
        // non bloquant
      } else {
        await loadMessages(data.id);
      }
    } catch (e) {
      setErr(e?.message || "Impossible de créer la conversation.");
    }
  }

  async function openConversation(id) {
    setActiveConvId(id);
    setErr("");
    try {
      await loadMessages(id);
    } catch (e) {
      setErr(e?.message || "Impossible de charger les messages.");
    }
  }

  async function send() {
    if (!draft.trim() || !activeConvId || busy) return;
    setBusy(true);
    setErr("");

    const content = draft.trim();
    setDraft("");

    try {
      // 1) insert message user
      const { error: uErr } = await supabase.from("messages").insert({
        conversation_id: activeConvId,
        role: "user",
        content,
      });
      if (uErr) throw uErr;

      await loadMessages(activeConvId);

      // 2) appeler ton API chat existante
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token || "";

      const r = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          agent_slug: slug,
          conversation_id: activeConvId,
          message: content,
        }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "Erreur API");

      // L’API doit renvoyer la réponse assistant OU avoir déjà écrit en base.
      // On recharge pour être certain d’avoir l’historique complet.
      await loadMessages(activeConvId);
    } catch (e) {
      setErr(e?.message || "Erreur interne. Réessayez plus tard.");
      // message visible côté UI
      await supabase.from("messages").insert({
        conversation_id: activeConvId,
        role: "assistant",
        content: "Erreur interne. Réessayez plus tard.",
      });
      await loadMessages(activeConvId);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.card}>Chargement…</div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <header style={styles.topbar}>
        <button style={styles.btnGhost} onClick={() => router.push("/agents")}>
          ← Retour
        </button>

        <div style={styles.brandWrap}>
          <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.brandLogo} />

          {/* ✅ Zone agent + bulle (c’est EXACTEMENT la zone rouge) */}
          <div style={styles.agentHeader}>
            <AgentBubble src={agentAvatar} size={22} alt={agent?.name || "agent"} />
            <div style={{ display: "grid", lineHeight: 1.1 }}>
              <div style={styles.agentName}>{agent?.name || slug}</div>
              <div style={styles.agentDesc}>{agent?.description || ""}</div>
            </div>
          </div>
        </div>

        <div style={styles.topRight}>
          <span style={styles.chip}>{me?.email || "user"}</span>
          <button style={styles.btnGhost} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </header>

      <section style={styles.layout}>
        <aside style={styles.left}>
          <div style={styles.leftHead}>
            <div style={styles.leftTitle}>Historique</div>
            <button style={styles.btnPrimary} onClick={createConversation}>
              + Nouvelle
            </button>
          </div>

          <div style={styles.list}>
            {conversations.map((c) => {
              const active = c.id === activeConvId;
              return (
                <button
                  key={c.id}
                  style={{ ...styles.convBtn, ...(active ? styles.convBtnOn : null) }}
                  onClick={() => openConversation(c.id)}
                  type="button"
                >
                  <div style={styles.convTop}>
                    <AgentBubble src={agentAvatar} size={18} alt={agent?.name || "agent"} />
                    <div style={styles.convTitle}>{c.title || "Conversation"}</div>
                  </div>
                  <div style={styles.convDate}>{fmtDate(c.created_at)}</div>
                </button>
              );
            })}
          </div>
        </aside>

        <div style={styles.main}>
          {err ? <div style={styles.alert}>{err}</div> : null}

          <div style={styles.chat}>
            {messages.map((m) => {
              const isUser = m.role === "user";
              return (
                <div key={m.id} style={{ ...styles.msgRow, justifyContent: isUser ? "flex-end" : "flex-start" }}>
                  {!isUser ? (
                    <div style={styles.msgLeft}>
                      <AgentBubble src={agentAvatar} size={18} alt={agent?.name || "agent"} />
                      <div style={styles.msgAuthor}>{agent?.name || "Agent"}</div>
                    </div>
                  ) : null}

                  <div style={{ ...styles.msg, ...(isUser ? styles.msgUser : styles.msgAgent) }}>
                    {m.content}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={styles.composer}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Écrivez votre message… (Entrée = envoyer, Maj+Entrée = saut de ligne)"
              style={styles.input}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button style={styles.send} onClick={send} disabled={busy || !draft.trim()}>
              Envoyer
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
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "#eef2ff",
    fontFamily: "Segoe UI, Arial, sans-serif",
  },

  topbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.28)",
    backdropFilter: "blur(10px)",
    gap: 12,
  },

  brandWrap: { display: "flex", alignItems: "center", gap: 14, minWidth: 0 },
  brandLogo: { height: 22, width: "auto", display: "block" },

  // ✅ Zone rouge = agentHeader
  agentHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.18)",
    minWidth: 0,
  },

  agentName: { fontWeight: 900, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  agentDesc: { fontWeight: 800, fontSize: 11, opacity: 0.75 },

  topRight: { display: "flex", gap: 10, alignItems: "center" },
  chip: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
    fontWeight: 900,
    fontSize: 12,
    maxWidth: 260,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "inherit",
  },

  btnGhost: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.35)",
    color: "inherit",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  btnPrimary: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,140,40,.30)",
    background: "rgba(255,140,40,.18)",
    color: "inherit",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  layout: {
    display: "grid",
    gridTemplateColumns: "360px 1fr",
    gap: 14,
    padding: 14,
  },

  left: {
    borderRadius: 22,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.45)",
    backdropFilter: "blur(14px)",
    overflow: "hidden",
    minHeight: "calc(100vh - 90px)",
    display: "flex",
    flexDirection: "column",
  },

  leftHead: {
    padding: 14,
    borderBottom: "1px solid rgba(255,255,255,.08)",
    background: "rgba(0,0,0,.18)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },

  leftTitle: { fontWeight: 900, fontSize: 13 },

  list: { padding: 12, overflowY: "auto", display: "grid", gap: 10 },

  convBtn: {
    width: "100%",
    textAlign: "left",
    padding: 12,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    color: "inherit",
    cursor: "pointer",
  },
  convBtnOn: {
    border: "1px solid rgba(255,140,40,.22)",
    background: "linear-gradient(135deg, rgba(255,140,40,.10), rgba(80,120,255,.08))",
  },

  convTop: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  convTitle: {
    fontWeight: 900,
    fontSize: 13,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  convDate: { marginTop: 6, opacity: 0.75, fontWeight: 800, fontSize: 11 },

  main: {
    borderRadius: 22,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.45)",
    backdropFilter: "blur(14px)",
    overflow: "hidden",
    minHeight: "calc(100vh - 90px)",
    display: "flex",
    flexDirection: "column",
  },

  alert: {
    margin: 12,
    padding: 12,
    borderRadius: 16,
    background: "rgba(255,140,40,.10)",
    border: "1px solid rgba(255,140,40,.18)",
    fontWeight: 900,
    fontSize: 13,
  },

  chat: { padding: 14, overflowY: "auto", flex: 1, display: "grid", gap: 12 },

  msgRow: { display: "flex", gap: 10, alignItems: "flex-start" },

  msgLeft: { display: "flex", gap: 8, alignItems: "center", paddingTop: 4 },
  msgAuthor: { fontWeight: 900, fontSize: 12, opacity: 0.9 },

  msg: {
    maxWidth: "78%",
    padding: "12px 14px",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    fontWeight: 800,
    fontSize: 13,
    lineHeight: 1.45,
    whiteSpace: "pre-wrap",
  },
  msgUser: {
    background: "rgba(255,255,255,.06)",
  },
  msgAgent: {},

  composer: {
    padding: 14,
    borderTop: "1px solid rgba(255,255,255,.08)",
    background: "rgba(0,0,0,.18)",
    display: "flex",
    gap: 12,
    alignItems: "center",
  },
  input: {
    flex: 1,
    minHeight: 46,
    maxHeight: 140,
    resize: "vertical",
    padding: "12px 14px",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 800,
    fontSize: 13,
  },
  send: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.22)",
    color: "inherit",
    fontWeight: 900,
    cursor: "pointer",
    opacity: 1,
  },

  card: {
    margin: "60px auto",
    maxWidth: 720,
    padding: 24,
    borderRadius: 22,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.45)",
    backdropFilter: "blur(14px)",
  },
};
