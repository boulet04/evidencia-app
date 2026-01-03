// pages/chat.js
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

      setEmail(session.user.email || "");

      const url = new URL(window.location.href);
      const slugRaw = url.searchParams.get("agent");
      const slug = (slugRaw || "").toLowerCase().trim();

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

      // ✅ Accueil propre (sans doublon du prénom)
      const label = slug.charAt(0).toUpperCase() + slug.slice(1);
      const role =
        cfg?.systemPrompt
          ?.replace(/^Tu es\s*/i, "")
          ?.replace(new RegExp(`^${label}\\s*,\\s*`, "i"), "")
          ?.trim() || "agent";

      setMessages([
        {
          role: "assistant",
          content: `Bonjour, je suis ${label}, ${role}. Comment puis-je vous aider ?`,
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
    if (!input.trim() || !agent) return;

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

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data?.error || "Erreur interne. Réessayez plus tard." },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data?.reply || "Réponse vide." },
        ]);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Erreur interne. Réessayez plus tard." },
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

  if (!agent) return null;

  const label = agent.slug.charAt(0).toUpperCase() + agent.slug.slice(1);

  return (
    <main style={styles.page}>
      <div style={styles.bg} aria-hidden="true">
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
      </div>

      <header style={styles.topbar}>
        <button
          type="button"
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
          <span style={styles.agentName}>{label}</span>
        </div>

        <div style={styles.topRight}>
          <span style={styles.userChip}>{email || "Connecté"}</span>
          <button type="button" style={styles.logout} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </header>

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
            type="button"
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
    overflow: "hidden",
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
    gap: 12,
  },

  back: {
    color: "#fff",
    fontWeight: 900,
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

  agentName: { fontWeight: 900, fontSize: 14, color: "#fff" },

  topRight: { display: "flex", alignItems: "center", gap: 10 },

  userChip: {
    padding: "8px 12px",
    borderRadius: 999,
    background: "rgba(255,255,255,.12)",
    border: "1px solid rgba(255,255,255,.14)",
    fontWeight: 800,
    color: "#fff",
  },

  logout: {
    color: "#fff",
    fontWeight: 900,
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
    boxSizing: "border-box",
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
    fontWeight: 700,
    whiteSpace: "pre-wrap",
    color: "#fff",
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
    minHeight: 46,
    resize: "none",
    boxSizing: "border-box",
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
