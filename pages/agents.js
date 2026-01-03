import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Chat() {
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [expired, setExpired] = useState(false);

  const agentSlug =
    typeof window !== "undefined"
      ? new URL(window.location.href).searchParams.get("agent") || "max"
      : "max";

  const firstAssistant =
    agentSlug === "max"
      ? "Bonjour, je suis Max, votre agent commercial. Dites-moi ce que vous vendez, à qui, et par quel canal."
      : "Bonjour, je suis votre agent. Comment puis-je vous aider ?";

  const [messages, setMessages] = useState([
    { role: "assistant", content: firstAssistant },
  ]);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const canSend = useMemo(
    () => input.trim().length > 0 && !sending,
    [input, sending]
  );

  useEffect(() => {
    let mounted = true;

    async function boot() {
      setChecking(true);

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        window.location.href = "/login";
        return;
      }

      if (!mounted) return;
      setEmail(session.user.email || "");

      const userId = session.user.id;

      const { data: profile } = await supabase
        .from("profiles")
        .select("expires_at")
        .eq("user_id", userId)
        .maybeSingle();

      if (profile?.expires_at) {
        const exp = new Date(profile.expires_at);
        if (exp.getTime() < Date.now()) setExpired(true);
      }

      setChecking(false);
      setLoading(false);

      supabase.auth.onAuthStateChange((_e, newSession) => {
        if (!newSession) window.location.href = "/login";
      });
    }

    boot();
    return () => {
      mounted = false;
    };
  }, []);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  async function sendMessage() {
    if (!canSend) return;

    const userText = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", content: userText }]);
    setSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userText,
          agent: agentSlug,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error();

      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.reply },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: "Erreur technique. Réessayez.",
        },
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

  if (loading || checking) {
    return <main style={styles.center}>Chargement…</main>;
  }

  if (expired) {
    return (
      <main style={styles.center}>
        <h1>Abonnement expiré</h1>
        <p>Veuillez contacter Evidenc’IA pour renouveler.</p>
        <button onClick={logout}>Déconnexion</button>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      {/* HEADER AVEC RETOUR */}
      <header style={styles.topbar}>
        <div style={styles.left}>
          <button
            style={styles.backBtn}
            onClick={() => (window.location.href = "/agents")}
          >
            ← Retour aux agents
          </button>

          <img
            src="/images/logolong.png"
            alt="Evidenc’IA"
            style={styles.logo}
          />
        </div>

        <div style={styles.right}>
          <span style={styles.email}>{email}</span>
          <button onClick={logout} style={styles.logout}>
            Déconnexion
          </button>
        </div>
      </header>

      {/* CHAT */}
      <section style={styles.chat}>
        <div style={styles.thread}>
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                ...styles.bubble,
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <strong>{m.role === "user" ? "Vous" : agentSlug}</strong>
              <div>{m.content}</div>
            </div>
          ))}
        </div>

        <div style={styles.inputBar}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Votre message…"
            rows={2}
            style={styles.textarea}
          />
          <button
            onClick={sendMessage}
            disabled={!canSend}
            style={styles.send}
          >
            Envoyer
          </button>
        </div>
      </section>
    </main>
  );
}

/* ================= STYLES ================= */

const styles = {
  page: { minHeight: "100vh", background: "#05060a", color: "#fff" },

  topbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 18px",
    background: "rgba(0,0,0,.5)",
    borderBottom: "1px solid rgba(255,255,255,.1)",
  },

  left: { display: "flex", alignItems: "center", gap: 16 },
  right: { display: "flex", alignItems: "center", gap: 12 },

  backBtn: {
    padding: "8px 14px",
    borderRadius: 999,
    background: "rgba(0,0,0,.4)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,.2)",
    fontWeight: 900,
    cursor: "pointer",
  },

  logo: { height: 22 },

  email: { fontSize: 12, opacity: 0.8 },

  logout: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.2)",
    background: "rgba(0,0,0,.4)",
    color: "#fff",
    cursor: "pointer",
  },

  chat: {
    maxWidth: 1000,
    margin: "0 auto",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    height: "calc(100vh - 70px)",
  },

  thread: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },

  bubble: {
    maxWidth: "70%",
    padding: 12,
    borderRadius: 14,
    background: "rgba(255,255,255,.1)",
  },

  inputBar: {
    display: "flex",
    gap: 10,
    marginTop: 12,
  },

  textarea: {
    flex: 1,
    borderRadius: 12,
    padding: 10,
    background: "rgba(0,0,0,.4)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,.2)",
  },

  send: {
    padding: "10px 16px",
    borderRadius: 999,
    background: "#fff",
    color: "#000",
    fontWeight: 900,
    cursor: "pointer",
  },

  center: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
  },
};
