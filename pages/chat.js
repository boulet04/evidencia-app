import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import agentPrompts from "../lib/agentPrompts";

export default function Chat() {
  const [email, setEmail] = useState("");
  const [agent, setAgent] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    async function init() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        window.location.href = "/login";
        return;
      }

      setEmail(session.user.email);

      // récupération du slug
      const url = new URL(window.location.href);
      const slug = url.searchParams.get("agent");

      if (!slug) {
        window.location.href = "/agents";
        return;
      }

      if (!agentPrompts[slug]) {
        alert("Agent introuvable.");
        window.location.href = "/agents";
        return;
      }

      setAgent({ slug, ...agentPrompts[slug] });

      // message d'accueil
      setMessages([
        {
          role: "assistant",
          content: `Bonjour, je suis ${slug}. Que puis-je faire pour vous ?`,
        },
      ]);
    }

    init();
  }, []);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  async function sendMessage() {
    if (!input.trim()) return;

    const userText = input.trim();
    setInput("");

    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setSending(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userText,
          agentSlug: agent.slug,
        }),
      });

      const data = await resp.json();

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply || "Erreur réponse." },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Je rencontre une erreur, veuillez réessayer.",
        },
      ]);
    }

    setSending(false);
  }

  function handleEnter(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  if (!agent) {
    return null;
  }

  return (
    <main style={styles.page}>
      {/* ARRIÈRE-PLAN */}
      <div style={styles.bg} aria-hidden="true">
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
      </div>

      {/* BARRE DU HAUT */}
      <header style={styles.topbar}>
        <button
          style={styles.back}
          onClick={() => (window.location.href = "/agents")}
        >
          ← Retour
        </button>

        <div style={styles.topCenter}>
          <img
            src="/images/logolong.png"
            style={styles.brandLogo}
            alt="EvidencIA"
          />
          <span style={styles.agentName}>{agent.slug}</span>
        </div>

        <button style={styles.logout} onClick={logout}>
          Déconnexion
        </button>
      </header>

      {/* ZONE DE CHAT */}
      <section style={styles.chat}>
        <div style={styles.thread}>
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                ...styles.msg,
                ...(m.role === "user" ? styles.user : styles.assistant),
              }}
            >
              {m.content}
            </div>
          ))}
        </div>

        <div style={styles.inputRow}>
          <textarea
            style={styles.textarea}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleEnter}
            placeholder="Votre message…"
          />
          <button
            style={styles.send}
            disabled={sending}
            onClick={sendMessage}
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
    position: "relative",
    color: "#fff",
    fontFamily: "Segoe UI, Arial",
  },
  bg: { position: "absolute", inset: 0, zIndex: 0 },
  bgLogo: {
    position: "absolute",
    inset: 0,
    backgroundImage: "url('/images/logopc.png')",
    backgroundSize: "contain",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    opacity: 0.08,
  },
  bgVeils: {
    position: "absolute",
    inset: 0,
    background:
      "linear-gradient(to bottom, rgba(0,0,0,.6), rgba(0,0,0,.3), rgba(0,0,0,.7))",
  },

  topbar: {
    zIndex: 10,
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 18px",
    backdropFilter: "blur(12px)",
    background: "rgba(0,0,0,.35)",
    borderBottom: "1px solid rgba(255,255,255,.12)",
  },

  back: {
    color: "#fff",
    fontWeight: 800,
    background: "transparent",
    border: "none",
    cursor: "pointer",
  },

  topCenter: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },

  brandLogo: { height: 26 },

  agentName: { fontWeight: 900, fontSize: 14 },

  logout: {
    color: "#fff",
    fontWeight: 800,
    background: "transparent",
    border: "1px solid rgba(255,255,255,.3)",
    padding: "6px 12px",
    borderRadius: 999,
    cursor: "pointer",
  },

  chat: {
    position: "relative",
    zIndex: 1,
    padding: 20,
    display: "flex",
    flexDirection: "column",
    height: "calc(100vh - 70px)",
  },

  thread: {
    flex: 1,
    overflowY: "auto",
    display: "grid",
    gap: 10,
    paddingBottom: 10,
  },

  msg: {
    padding: "10px 14px",
    borderRadius: 14,
    maxWidth: "70%",
    fontWeight: 600,
    whiteSpace: "pre-wrap",
  },

  user: {
    marginLeft: "auto",
    background: "rgba(255,255,255,.15)",
  },

  assistant: {
    marginRight: "auto",
    background: "rgba(0,0,0,.35)",
  },

  inputRow: {
    display: "flex",
    gap: 10,
  },

  textarea: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    background: "rgba(0,0,0,.25)",
    border: "1px solid rgba(255,255,255,.15)",
    color: "#fff",
  },

  send: {
    padding: "12px 16px",
    borderRadius: 12,
    background: "rgba(255,255,255,.25)",
    color: "#fff",
    fontWeight: 900,
    border: "none",
    cursor: "pointer",
  },
};
