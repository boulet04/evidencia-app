// pages/chat.js
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function ChatPage() {
  const [sessionEmail, setSessionEmail] = useState("");
  const [agentSlug, setAgentSlug] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState("");
  const [agentAvatar, setAgentAvatar] = useState("");

  const [isMobile, setIsMobile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const [conversations, setConversations] = useState([]);
  const [selectedConvId, setSelectedConvId] = useState("");
  const [messages, setMessages] = useState([]);

  const [input, setInput] = useState("");
  const endRef = useRef(null);

  // --- Micro / dictée ---
  const recognitionRef = useRef(null);
  const [micSupported, setMicSupported] = useState(false);
  const [listening, setListening] = useState(false);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  function goBack() {
    window.location.href = "/agents";
  }

  // Responsive
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 980px)");
    const apply = () => setIsMobile(!!mql.matches);
    apply();
    mql.addEventListener?.("change", apply);
    return () => mql.removeEventListener?.("change", apply);
  }, []);

  // Init dictée (Web Speech API)
  useEffect(() => {
    const SR =
      typeof window !== "undefined"
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;

    if (!SR) {
      setMicSupported(false);
      return;
    }

    setMicSupported(true);
    const rec = new SR();
    rec.lang = "fr-FR";
    rec.continuous = false; // évite répétitions
    rec.interimResults = false; // évite doublons incrémentaux
    rec.maxAlternatives = 1;

    rec.onstart = () => setListening(true);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);

    rec.onresult = (event) => {
      try {
        const transcript = (event?.results?.[0]?.[0]?.transcript || "").trim();
        if (!transcript) return;

        setInput((prev) => {
          const p = (prev || "").trim();
          return p ? `${p} ${transcript}` : transcript;
        });
      } catch {
        // no-op
      }
    };

    recognitionRef.current = rec;

    return () => {
      try {
        rec.onresult = null;
        rec.onstart = null;
        rec.onend = null;
        rec.onerror = null;
        rec.stop?.();
      } catch {
        // no-op
      }
      recognitionRef.current = null;
    };
  }, []);

  function toggleMic() {
    if (!micSupported || !recognitionRef.current) {
      alert("Micro non supporté sur ce navigateur.");
      return;
    }
    try {
      if (listening) recognitionRef.current.stop();
      else recognitionRef.current.start();
    } catch {
      // start() peut throw si appelé trop vite
    }
  }

  // Boot: session + agent + conversations/messages
  useEffect(() => {
    (async () => {
      setLoading(true);

      const { data: sess } = await supabase.auth.getSession();
      const email = sess?.session?.user?.email || "";
      setSessionEmail(email);

      // agent depuis querystring ?agent=emma sinon localStorage
      const params = new URLSearchParams(window.location.search);
      const qsAgent = (params.get("agent") || "").trim().toLowerCase();
      const stored = (window.localStorage.getItem("selected_agent_slug") || "").trim().toLowerCase();

      const slug = (qsAgent || stored || "emma").trim().toLowerCase();
      window.localStorage.setItem("selected_agent_slug", slug);
      setAgentSlug(slug);

      // Charger infos agent
      const { data: agent } = await supabase
        .from("agents")
        .select("slug,name,description,avatar_url")
        .eq("slug", slug)
        .maybeSingle();

      setAgentName(agent?.name || slug);
      setAgentRole(agent?.description || "");
      setAgentAvatar(agent?.avatar_url || "");

      // Charger conversations (SANS archived)
      const { data: convs, error: convErr } = await supabase
        .from("conversations")
        .select("id,user_id,created_at,agent_slug,title")
        .eq("agent_slug", slug)
        .order("created_at", { ascending: false });

      if (convErr) {
        console.error("Erreur fetch conversations:", convErr);
      }

      const list = convs || [];
      setConversations(list);

      const firstId = list?.[0]?.id || "";
      setSelectedConvId(firstId);

      // Charger messages
      if (firstId) {
        const { data: msgs } = await supabase
          .from("messages")
          .select("id,conversation_id,role,content,created_at")
          .eq("conversation_id", firstId)
          .order("created_at", { ascending: true });

        setMessages(msgs || []);
      } else {
        setMessages([]);
      }

      setLoading(false);
    })();
  }, []);

  // Scroll to bottom on messages change
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const selectedConversation = useMemo(() => {
    return conversations.find((c) => c.id === selectedConvId) || null;
  }, [conversations, selectedConvId]);

  async function selectConversation(id) {
    setSelectedConvId(id);
    setDrawerOpen(false);

    const { data: msgs } = await supabase
      .from("messages")
      .select("id,conversation_id,role,content,created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true });

    setMessages(msgs || []);
  }

  async function newConversationInternal(title = "Nouvelle conversation") {
    const { data: sess } = await supabase.auth.getSession();
    const userId = sess?.session?.user?.id;
    if (!userId) throw new Error("Non authentifié.");

    // INSERT SANS archived
    const { data: conv, error } = await supabase
      .from("conversations")
      .insert([{ user_id: userId, agent_slug: agentSlug, title }])
      .select("id,user_id,created_at,agent_slug,title")
      .maybeSingle();

    if (error) throw new Error(error.message);
    return conv;
  }

  async function newConversation() {
    try {
      const conv = await newConversationInternal("Nouvelle conversation");
      const next = [conv, ...conversations];
      setConversations(next);
      setSelectedConvId(conv.id);
      setMessages([]);
      setDrawerOpen(false);
    } catch (e) {
      alert(String(e?.message || e));
    }
  }

  function buildAutoTitleFromFirstMessage(text) {
    const t = (text || "").trim().replace(/\s+/g, " ");
    if (!t) return "Conversation";
    const words = t.split(" ").slice(0, 7).join(" ");
    return words.length < t.length ? `${words}…` : words;
  }

  async function ensureConversationSelected(forFirstMessageText) {
    if (selectedConvId) return selectedConvId;

    // Aucune conversation: on en crée une automatiquement
    const autoTitle = buildAutoTitleFromFirstMessage(forFirstMessageText);
    const conv = await newConversationInternal(autoTitle);
    setConversations((prev) => [conv, ...prev]);
    setSelectedConvId(conv.id);
    setMessages([]);
    setDrawerOpen(false);
    return conv.id;
  }

  async function maybeUpdateConversationTitleIfDefault(convId, firstUserText) {
    const conv = conversations.find((c) => c.id === convId) || null;
    const currentTitle = (conv?.title || "").trim();

    if (currentTitle && currentTitle !== "Nouvelle conversation") return;

    const newTitle = buildAutoTitleFromFirstMessage(firstUserText);

    await supabase.from("conversations").update({ title: newTitle }).eq("id", convId);

    setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, title: newTitle } : c)));
  }

  async function sendMessage() {
    const text = (input || "").trim();
    if (!text) return;

    setSending(true);
    setInput("");

    try {
      const convId = await ensureConversationSelected(text);

      // 1) Sauvegarde message user
      await supabase.from("messages").insert([{ conversation_id: convId, role: "user", content: text }]);

      // 1b) Auto-titre si première interaction
      if ((messages || []).length === 0) {
        await maybeUpdateConversationTitleIfDefault(convId, text);
      }

      // 2) Refresh messages
      const { data: msgs1 } = await supabase
        .from("messages")
        .select("id,conversation_id,role,content,created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true });

      setMessages(msgs1 || []);

      // 3) Appel agent
      const token = await getAccessToken();
      if (!token) throw new Error("Non authentifié.");

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: text, agentSlug }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);

      const reply = (data.reply || data.answer || data.content || "").toString().trim();

      // 4) Sauvegarde message assistant
      await supabase
        .from("messages")
        .insert([{ conversation_id: convId, role: "assistant", content: reply || "Réponse vide." }]);

      const { data: msgs2 } = await supabase
        .from("messages")
        .select("id,conversation_id,role,content,created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true });

      setMessages(msgs2 || []);
    } catch (e) {
      const msg = `Erreur: ${String(e?.message || e)}`;
      const convId = selectedConvId || null;
      if (convId) {
        await supabase.from("messages").insert([{ conversation_id: convId, role: "assistant", content: msg }]);
        const { data: msgs2 } = await supabase
          .from("messages")
          .select("id,conversation_id,role,content,created_at")
          .eq("conversation_id", convId)
          .order("created_at", { ascending: true });
        setMessages(msgs2 || []);
      } else {
        alert(msg);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <main style={styles.page}>
      {/* HEADER */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.headerBtn} onClick={goBack}>
            ← Retour
          </button>

          <div style={styles.agentBlock}>
            <div style={styles.agentAvatarWrap}>
              {agentAvatar ? <img src={agentAvatar} alt={agentName} style={styles.agentAvatar} /> : <div style={styles.agentAvatarFallback} />}
            </div>
            <div style={{ lineHeight: 1.1 }}>
              <div style={styles.agentName}>{agentName || "Agent"}</div>
              <div style={styles.agentRole}>{agentRole || "Assistant"}</div>
            </div>
          </div>
        </div>

        <div style={styles.headerCenter}>
          <img
            src="/images/logolong.png"
            alt="Evidenc'IA"
            style={styles.logo}
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        </div>

        <div style={styles.headerRight}>
          <div style={styles.emailPill}>{sessionEmail || ""}</div>

          <button style={styles.headerBtnDanger} onClick={logout}>
            Déconnexion
          </button>

          {isMobile && (
            <button style={styles.headerBtn} onClick={() => setDrawerOpen((v) => !v)}>
              Historique
            </button>
          )}
        </div>
      </div>

      {/* LAYOUT */}
      <div style={styles.layout}>
        {/* SIDEBAR desktop */}
        {!isMobile && (
          <aside style={styles.sidebar}>
            <div style={styles.sidebarHead}>
              <div style={styles.sidebarTitle}>Historique</div>
              <button style={styles.newBtn} onClick={newConversation}>
                + Nouvelle
              </button>
            </div>

            <div style={styles.sidebarList}>
              {conversations.map((c) => {
                const active = c.id === selectedConvId;
                return (
                  <button
                    key={c.id}
                    style={{ ...styles.convItem, ...(active ? styles.convItemActive : {}) }}
                    onClick={() => selectConversation(c.id)}
                    title={c.title || "Conversation"}
                  >
                    {c.title || "Conversation"}
                  </button>
                );
              })}
              {conversations.length === 0 && <div style={styles.muted}>Aucune conversation.</div>}
            </div>
          </aside>
        )}

        {/* Drawer mobile */}
        {isMobile && drawerOpen && (
          <div style={styles.drawerOverlay} onClick={() => setDrawerOpen(false)}>
            <div style={styles.drawer} onClick={(e) => e.stopPropagation()}>
              <div style={styles.sidebarHead}>
                <div style={styles.sidebarTitle}>Historique</div>
                <button style={styles.newBtn} onClick={newConversation}>
                  + Nouvelle
                </button>
              </div>
              <div style={styles.sidebarList}>
                {conversations.map((c) => {
                  const active = c.id === selectedConvId;
                  return (
                    <button
                      key={c.id}
                      style={{ ...styles.convItem, ...(active ? styles.convItemActive : {}) }}
                      onClick={() => selectConversation(c.id)}
                    >
                      {c.title || "Conversation"}
                    </button>
                  );
                })}
                {conversations.length === 0 && <div style={styles.muted}>Aucune conversation.</div>}
              </div>
            </div>
          </div>
        )}

        {/* CHAT */}
        <section style={styles.chat}>
          <div style={styles.chatInner}>
            {loading ? (
              <div style={styles.muted}>Chargement…</div>
            ) : (
              <>
                <div style={styles.msgList}>
                  {messages.map((m) => {
                    const isUser = m.role === "user";
                    return (
                      <div key={m.id} style={{ ...styles.msgRow, justifyContent: isUser ? "flex-end" : "flex-start" }}>
                        <div style={{ ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleAssistant) }}>
                          <div style={styles.bubbleText}>{m.content}</div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={endRef} />
                </div>

                <div style={styles.composer}>
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Écrire…"
                    style={styles.input}
                    rows={isMobile ? 2 : 3}
                    onKeyDown={(e) => {
                      // Entrée => envoyer | Shift+Entrée => nouvelle ligne
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (!sending) sendMessage();
                      }
                    }}
                  />

                  {/* Micro à droite, juste avant Envoyer */}
                  <button
                    type="button"
                    onClick={toggleMic}
                    title={micSupported ? (listening ? "Arrêter la dictée" : "Dicter (micro)") : "Micro non supporté"}
                    style={{
                      ...styles.micBtn,
                      ...(listening ? styles.micBtnActive : {}),
                      ...(micSupported ? {} : styles.micBtnDisabled),
                    }}
                    disabled={!micSupported}
                  >
                    <MicIcon />
                  </button>

                  <button style={styles.sendBtn} onClick={sendMessage} disabled={sending}>
                    {sending ? "…" : "Envoyer"}
                  </button>
                </div>

                {!!selectedConversation && (
                  <div style={styles.tinyNote}>
                    Conversation: <span style={{ fontFamily: "monospace" }}>{selectedConversation.id.slice(0, 8)}…</span>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a1 1 0 1 1 2 0a7 7 0 0 1-6 6.92V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.08A7 7 0 0 1 5 11a1 1 0 1 1 2 0a5 5 0 0 0 10 0z"
      />
    </svg>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "rgba(238,242,255,.92)",
    fontFamily: '"Segoe UI", Arial, sans-serif',
    overflow: "hidden",
  },

  header: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 12px 0",
    flexWrap: "wrap",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12, minWidth: 280 },
  headerCenter: { display: "flex", alignItems: "center", justifyContent: "center", flex: 1, minWidth: 140 },
  headerRight: { display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end", minWidth: 280, flexWrap: "wrap" },

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
  emailPill: {
    padding: "8px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.06)",
    fontWeight: 800,
    fontSize: 12,
    opacity: 0.9,
    maxWidth: 240,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  logo: { height: 28, width: "auto", opacity: 0.95, display: "block" },

  agentBlock: { display: "flex", alignItems: "center", gap: 10 },
  agentAvatarWrap: { width: 44, height: 44, borderRadius: 999, overflow: "hidden", border: "1px solid rgba(255,255,255,.12)" },
  agentAvatar: { width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 15%" },
  agentAvatarFallback: { width: "100%", height: "100%", background: "rgba(255,255,255,.06)" },
  agentName: { fontWeight: 900, fontSize: 16 },
  agentRole: { fontWeight: 800, opacity: 0.75, fontSize: 12 },

  layout: {
    display: "grid",
    gridTemplateColumns: "360px 1fr",
    gap: 14,
    padding: 12,
    height: "calc(100vh - 64px)",
  },

  sidebar: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  sidebarHead: {
    padding: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderBottom: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.12)",
  },
  sidebarTitle: { fontWeight: 900 },
  newBtn: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  sidebarList: { padding: 12, display: "grid", gap: 10, overflow: "auto" },

  convItem: {
    textAlign: "left",
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    color: "rgba(238,242,255,.92)",
    fontWeight: 900,
    cursor: "pointer",
  },
  convItemActive: { borderColor: "rgba(255,140,40,.35)", background: "rgba(255,140,40,.10)" },

  chat: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  chatInner: { display: "flex", flexDirection: "column", height: "100%" },
  msgList: { padding: 12, overflow: "auto", flex: 1 },

  msgRow: { display: "flex", marginBottom: 10 },
  bubble: {
    maxWidth: "min(820px, 92%)",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,.12)",
    padding: 12,
    boxShadow: "0 10px 24px rgba(0,0,0,.35)",
  },
  bubbleUser: { background: "rgba(255,255,255,.08)" },
  bubbleAssistant: { background: "rgba(0,0,0,.20)" },
  bubbleText: {
    whiteSpace: "pre-wrap",
    lineHeight: 1.35,
    fontWeight: 650,
    fontSize: 14,
  },

  composer: {
    display: "flex",
    gap: 10,
    padding: 12,
    borderTop: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.12)",
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    resize: "none",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    padding: 12,
    outline: "none",
    fontWeight: 800,
    lineHeight: 1.3,
  },

  // Micro (juste avant Envoyer)
  micBtn: {
    width: 46,
    height: 46,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    fontWeight: 900,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "0 0 auto",
  },
  micBtnActive: {
    borderColor: "rgba(255,80,80,.45)",
    background: "rgba(255,80,80,.12)",
  },
  micBtnDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },

  // Envoyer orange
  sendBtn: {
    borderRadius: 14,
    padding: "12px 14px",
    border: "1px solid rgba(255,140,40,.45)",
    background: "rgba(255,140,40,.18)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    minWidth: 104,
  },

  tinyNote: { padding: "0 12px 10px", opacity: 0.7, fontWeight: 800, fontSize: 12 },
  muted: { opacity: 0.75, fontWeight: 800 },

  drawerOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.65)",
    zIndex: 9999,
    display: "flex",
  },
  drawer: {
    width: "min(420px, 86vw)",
    height: "100%",
    background: "rgba(0,0,0,.85)",
    borderRight: "1px solid rgba(255,255,255,.12)",
    padding: 12,
    display: "flex",
    flexDirection: "column",
  },
};
