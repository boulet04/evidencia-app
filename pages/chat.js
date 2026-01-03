import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Chat() {
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(true);

  const [email, setEmail] = useState("");
  const [agent, setAgent] = useState(null); // données agent depuis Supabase
  const [expired, setExpired] = useState(false);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const canSend = useMemo(() => input.trim().length > 0 && !sending, [input, sending]);

  useEffect(() => {
    let mounted = true;

    async function boot() {
      setChecking(true);

      // 1) SESSION
      const { data: { session }, error: sessErr } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = "/login";
        return;
      }
      if (!mounted) return;

      setEmail(session.user.email || "");

      // 2) RÉCUPÈRE SLUG AGENT DANS L’URL
      const params = new URLSearchParams(window.location.search);
      const slug = params.get("agent");

      if (!slug) {
        window.location.href = "/agents";
        return;
      }

      // 3) CHARGER AGENT DANS SUPABASE
      const { data: agentData, error: agentErr } = await supabase
        .from("agents")
        .select("id, name, slug, avatar_url, description, system_prompt")
        .eq("slug", slug)
        .maybeSingle();

      if (!mounted) return;

      if (agentErr || !agentData) {
        alert("Agent introuvable.");
        window.location.href = "/agents";
        return;
      }

      setAgent(agentData);

      // 4) EXPIRATION ABONNEMENT
      const userId = session.user.id;

      const { data: profile, error: profErr } = await supabase
        .from("profiles")
        .select("expires_at")
        .eq("user_id", userId)
        .maybeSingle();

      if (profile?.expires_at) {
        const expiresAt = new Date(profile.expires_at);
        if (expiresAt.getTime() < Date.now()) {
          setExpired(true);
        }
      }

      setChecking(false);
      setLoading(false);

      // 5) MESSAGE INTRO PERSONNALISÉ
      setMessages([
        {
          role: "assistant",
          content:
            `Bonjour, je suis ${agentData.name}. ${agentData.description || ""}`
        }
      ]);

      // 6) ÉVÈNEMENTS AUTH
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
        if (!newSession) window.location.href = "/login";
      });

      return () => subscription?.unsubscribe();
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
    setErrorMsg("");

    const userText = input.trim();
    setInput("");

    setMessages(prev => [...prev, { role: "user", content: userText }]);
    setSending(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userText,
          agentSlug: agent.slug
        }),
      });

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        throw new Error(data?.error || "Erreur API");
      }

      const reply = data?.reply || "Je n'ai pas pu générer une réponse.";
      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch (err) {
      setErrorMsg("Erreur lors de l’envoi. Vérifiez /api/chat.");
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

  // ===========================
  // EXPIRATION
  // ===========================
  if (expired) {
    return (
      <main style={styles.page}>
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />

        <section style={styles.center}>
          <div style={styles.card}>
            <h1 style={styles.h1}>Abonnement expiré</h1>
            <p style={styles.p}>
              Veuillez contacter Evidenc’IA pour renouveler votre abonnement.
            </p>

            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <a href="tel:+33665752635" style={styles.pill}>Appeler</a>
              <a href="mailto:evidenciatech@gmail.com" style={styles.pill}>Email</a>
            </div>

            <button style={{ ...styles.pillGhost, marginTop: 16 }} onClick={logout}>
              Déconnexion
            </button>
          </div>
        </section>
      </main>
    );
  }

  // ===========================
  // LOADING
  // ===========================
  if (loading || checking || !agent) {
    return (
      <main style={styles.page}>
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
        <section style={styles.center}>
          <div style={styles.card}>
            <div style={styles.h1}>Chargement…</div>
            <div style={styles.subtle}>Initialisation de l’agent…</div>
          </div>
        </section>
      </main>
    );
  }

  // ===========================
  // PAGE CHAT FINALE
  // ===========================
  return (
    <main style={styles.page}>
      <div style={styles.bgLogo} />
      <div style={styles.bgVeils} />

      {/* TOP BAR */}
      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.logo} />
          <button style={styles.btnReturn} onClick={() => (window.location.href = "/agents")}>
            ← Retour
          </button>
        </div>

        <div style={styles.topRight}>
          <img
            src={agent.avatar_url}
            style={styles.agentAvatar}
            alt={agent.name}
          />
          <span style={styles.agentName}>{agent.name}</span>

          <span style={styles.userChip}>{email || "Connecté"}</span>
          <button onClick={logout} style={styles.btnGhost}>Déconnexion</button>
        </div>
      </header>

      {/* ZONE CHAT */}
      <section style={styles.shell}>
        <div style={styles.chatCard}>
          {errorMsg && <div style={styles.alert}>{errorMsg}</div>}

          <div style={styles.thread}>
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
              placeholder="Écrivez votre message…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
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

//
// ========================= STYLES =========================
// (identiques à la charte Evidenc’IA)
//

const styles = {
  page: {
    minHeight: "100vh",
    position: "relative",
    fontFamily: "Segoe UI, Arial, sans-serif",
    color: "#eef2ff",
    background: "linear-gradient(135deg,#05060a,#0a0d16)"
  },

  bgLogo: {
    position: "absolute",
    inset: 0,
    backgroundImage: "url('/images/logopc.png')",
    backgroundRepeat: "no-repeat",
    backgroundSize: "contain",
    backgroundPosition: "center",
    opacity: 0.12
  },

  bgVeils: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(900px 600px at 55% 42%, rgba(255,140,40,.22), rgba(0,0,0,0) 62%)," +
      "radial-gradient(900px 600px at 35% 55%, rgba(80,120,255,.18), rgba(0,0,0,0) 62%)," +
      "linear-gradient(to bottom, rgba(0,0,0,.62), rgba(0,0,0,.22) 30%, rgba(0,0,0,.22) 70%, rgba(0,0,0,.66))"
  },

  // TOPBAR
  topbar: {
    position: "relative",
    zIndex: 1,
    padding: "16px 18px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "rgba(0,0,0,.28)",
    borderBottom: "1px solid rgba(255,255,255,.10)",
    backdropFilter: "blur(12px)"
  },

  topLeft: { display: "flex", alignItems: "center", gap: 20 },

  logo: { height: 26 },

  btnReturn: {
    padding: "8px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.35)",
    color: "#eef2ff",
    cursor: "pointer",
    fontWeight: 900,
  },

  topRight: { display: "flex", alignItems: "center", gap: 12 },

  agentAvatar: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    objectFit: "cover"
  },

  agentName: {
    fontWeight: 900,
    fontSize: 14
  },

  userChip: {
    fontSize: 12,
    fontWeight: 900,
    padding: "8px 12px",
    borderRadius: 999,
    background: "rgba(0,0,0,.35)",
    border: "1px solid rgba(255,255,255,.12)"
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

  // CHAT AREA
  shell: {
    position: "relative",
    zIndex: 1,
    padding: 18,
    display: "grid",
    placeItems: "center"
  },

  chatCard: {
    width: "100%",
    maxWidth: 980,
    borderRadius: 26,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    border: "1px solid rgba(255,255,255,.12)",
    backdropFilter: "blur(14px)",
    overflow: "hidden"
  },

  alert: {
    margin: 14,
    padding: 12,
    borderRadius: 16,
    background: "rgba(255,140,40,.10)",
    border: "1px solid rgba(255,140,40,.25)"
  },

  thread: {
    height: "calc(100vh - 220px)",
    overflowY: "auto",
    padding: 18,
    display: "grid",
    gap: 12
  },

  bubbleRow: { display: "flex" },

  bubble: {
    maxWidth: 720,
    borderRadius: 18,
    padding: "12px 14px",
    background: "rgba(0,0,0,.35)",
    border: "1px solid rgba(255,255,255,.12)",
    lineHeight: 1.45
  },

  bubbleUser: {
    background: "rgba(255,255,255,.10)"
  },

  role: {
    fontSize: 11,
    fontWeight: 900,
    opacity: 0.75,
    marginBottom: 6
  },

  text: {
    fontSize: 14,
    fontWeight: 700,
    whiteSpace: "pre-wrap"
  },

  composer: {
    display: "flex",
    gap: 10,
    padding: 14,
    background: "rgba(0,0,0,.22)",
    borderTop: "1px solid rgba(255,255,255,.10)"
  },

  textarea: {
    flex: 1,
    resize: "none",
    padding: "12px 14px",
    borderRadius: 18,
    background: "rgba(0,0,0,.40)",
    color: "#eef2ff",
    outline: "none",
    fontSize: 14,
    fontWeight: 800
  },

  btn: {
    padding: "12px 16px",
    borderRadius: 999,
    background:
      "linear-gradient(135deg, rgba(255,140,40,.22), rgba(80,120,255,.14))",
    border: "1px solid rgba(255,255,255,.14)",
    fontWeight: 900,
    cursor: "pointer"
  },

  btnDisabled: {
    padding: "12px 16px",
    borderRadius: 999,
    background: "rgba(255,255,255,.06)",
    border: "1px solid rgba(255,255,255,.10)",
    fontWeight: 900
  },

  center: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24
  },

  card: {
    width: "100%",
    maxWidth: 560,
    borderRadius: 26,
    padding: 24,
    background: "rgba(0,0,0,.55)",
    border: "1px solid rgba(255,255,255,.12)"
  },

  h1: { fontSize: 32, fontWeight: 900, marginBottom: 10 },
  p: { fontSize: 14, fontWeight: 800, color: "#ccc", marginBottom: 10 },

  subtle: { fontSize: 12, fontWeight: 800, opacity: 0.7 },

  pill: {
    padding: "10px 14px",
    borderRadius: 999,
    background: "rgba(255,255,255,.12)",
    color: "#eef2ff",
    textDecoration: "none",
    fontWeight: 900
  },

  pillGhost: {
    padding: "10px 14px",
    borderRadius: 999,
    background: "rgba(0,0,0,.35)",
    border: "1px solid rgba(255,255,255,.14)",
    fontWeight: 900,
    color: "#eef2ff",
    cursor: "pointer"
  }
};
