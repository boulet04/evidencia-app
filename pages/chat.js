import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import agentPrompts from "../lib/agentPrompts";

export default function Chat() {
  const [email, setEmail] = useState("");
  const [agent, setAgent] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const canSend = useMemo(() => input.trim().length > 0 && !sending, [input, sending]);

  useEffect(() => {
    let mounted = true;

    async function init() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        window.location.href = "/login";
        return;
      }

      if (!mounted) return;
      setEmail(session.user.email || "");

      // slug depuis l'URL
      const url = new URL(window.location.href);
      const slug = (url.searchParams.get("agent") || "").trim().toLowerCase();

      if (!slug) {
        window.location.href = "/agents";
        return;
      }

      const cfg = agentPrompts[slug];
      if (!cfg) {
        alert("Agent introuvable.");
        window.location.href = "/agents";
        return;
      }

      setAgent({ slug, ...cfg });

      // message d'accueil "propre" (nom capitalisé + description)
      const displayName = slug.charAt(0).toUpperCase() + slug.slice(1);
      setMessages([
        {
          role: "assistant",
          content: `Bonjour, je suis ${displayName}, ${cfg.systemPrompt.replace(/^Tu es\s+/i, "").replace(/\.$/, "")}. Comment puis-je vous aider ?`,
        },
      ]);
    }

    init();
    return () => {
      mounted = false;
    };
  }, []);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  async function sendMessage() {
    if (!canSend || !agent) return;

    const userText = input.trim();
    setInput("");

    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setSending(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText, agentSlug: agent.slug }),
      });

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        // tant que OPENAI_API_KEY pas mise, ça tombera ici
        throw new Error(data?.error || "Erreur interne");
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data?.reply || "Réponse vide." },
      ]);
    } catch (_e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Erreur interne. Réessayez plus tard." },
      ]);
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

  if (!agent) return null;

  const agentLabel = agent.slug.charAt(0).toUpperCase() + agent.slug.slice(1);

  return (
    <main style={styles.page}>
      {/* Fond */}
      <div style={styles.bg} aria-hidden="true">
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
      </div>

      {/* Topbar */}
      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <button
            style={styles.back}
            onClick={() => (window.location.href = "/agents")}
            type="button"
          >
            ← Retour
          </button>

          <div style={styles.brandWrap}>
            <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.brandLogo} />
            <span style={styles.agentTitle}>
              {agentLabel}
              <span style={styles.agentSubtitle}> — {agent.systemPrompt.replace(/^Tu es\s+/i, "")}</span>
            </span>
          </div>
        </div>

        <div style={styles.topRight}>
          <span style={styles.userChip}>{email}</span>
          <button style={styles.logout} onClick={logout} type="button">
            Déconnexion
          </button>
        </div>
      </header>

      {/* Layout chat : thread + composer */}
      <section style={styles.shell}>
        <div style={styles.thread} id="thread">
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                ...styles.row,
                justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  ...styles.bubble,
                  ...(m.role === "user" ? styles.bubbleUser : styles.bubbleBot),
                }}
              >
                <div style={styles.bubbleRole}>
                  {m.role === "user" ? "Vous" : agentLabel}
                </div>
                <div style={styles.bubbleText}>{m.content}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={styles.composer}>
          <textarea
            style={styles.textarea}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Votre message…"
            rows={2}
          />
          <button
            style={canSend ? styles.sendBtn : styles.sendBtnDisabled}
            onClick={sendMessage}
            disabled={!canSend}
            type="button"
          >
            {sending ? "..." : "Envoyer"}
          </button>
        </div>
      </section>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    height: "100vh",
    position: "relative",
    overflow: "hidden",
    fontFamily: "Segoe UI, Arial, sans-serif",
    color: "#ffffff", // IMPORTANT : force blanc partout
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
      "radial-gradient(900px 600px at 55% 42%, rgba(255,140,40,.18), rgba(0,0,0,0) 62%)," +
      "radial-gradient(900px 600px at 35% 55%, rgba(80,120,255,.14), rgba(0,0,0,0) 62%)," +
      "linear-gradient(to bottom, rgba(0,0,0,.62), rgba(0,0,0,.26) 30%, rgba(0,0,0,.26) 70%, rgba(0,0,0,.66))",
  },

  topbar: {
    position: "relative",
    zIndex: 2,
    height: 64,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    borderBottom: "1px solid rgba(255,255,255,.12)",
    color: "#fff",
  },

  topLeft: { display: "flex", alignItems: "center", gap: 14, minWidth: 0 },

  back: {
    color: "#fff",
    fontWeight: 900,
    fontSize: 13,
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.18)",
    background: "rgba(0,0,0,.35)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  brandWrap: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    minWidth: 0,
  },

  brandLogo: { height: 26, width: "auto", display: "block" },

  agentTitle: {
    color: "#fff",
    fontWeight: 900,
    fontSize: 13,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  agentSubtitle: {
    color: "rgba(255,255,255,.75)",
    fontWeight: 800,
  },

  topRight: { display: "flex", alignItems: "center", gap: 10 },

  userChip: {
    color: "rgba(255,255,255,.92)",
    fontSize: 12,
    fontWeight: 900,
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.35)",
    maxWidth: 320,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  logout: {
    color: "#fff",
    fontWeight: 900,
    background: "rgba(0,0,0,.35)",
    border: "1px solid rgba(255,255,255,.18)",
    padding: "10px 14px",
    borderRadius: 999,
    cursor: "pointer",
  },

  // IMPORTANT : calc de hauteur correct + pas de "message coupé"
  shell: {
    position: "relative",
    zIndex: 1,
    height: "calc(100vh - 64px)", // topbar = 64
    display: "flex",
    flexDirection: "column",
    padding: 16,
    gap: 12,
  },

  thread: {
    flex: 1,
    overflowY: "auto",
    display: "grid",
    gap: 12,
    padding: 12,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.28)",
    backdropFilter: "blur(10px)",
  },

  row: { display: "flex" },

  bubble: {
    maxWidth: "70%",
    borderRadius: 16,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.12)",
    boxShadow: "0 14px 40px rgba(0,0,0,.35)",
    whiteSpace: "pre-wrap",
    lineHeight: 1.45,
    color: "#fff",
  },

  bubbleUser: { background: "rgba(255,255,255,.12)" },
  bubbleBot: { background: "rgba(0,0,0,.40)" },

  bubbleRole: {
    fontSize: 11,
    fontWeight: 900,
    color: "rgba(255,255,255,.80)", // BLANC (pas noir)
    marginBottom: 6,
  },

  bubbleText: {
    fontSize: 14,
    fontWeight: 800,
    color: "rgba(255,255,255,.92)", // BLANC (pas noir)
  },

  composer: {
    display: "flex",
    gap: 10,
    padding: 12,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.28)",
    backdropFilter: "blur(10px)",
  },

  textarea: {
    flex: 1,
    resize: "none",
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.40)",
    color: "#fff",
    outline: "none",
    fontWeight: 800,
    fontSize: 14,
    lineHeight: 1.4,
    minHeight: 44,
  },

  sendBtn: {
    padding: "12px 16px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.12)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    minWidth: 110,
  },

  sendBtnDisabled: {
    padding: "12px 16px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(255,255,255,.55)",
    fontWeight: 900,
    cursor: "not-allowed",
    minWidth: 110,
  },
};
