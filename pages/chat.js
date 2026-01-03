// pages/chat.js
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Chat() {
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(true);

  const [email, setEmail] = useState("");
  const [expired, setExpired] = useState(false);

  const [agent, setAgent] = useState({
    slug: "max",
    name: "Max",
    description: "Agent commercial",
    avatar_url: "/images/logolong.png",
  });

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const threadRef = useRef(null);

  const canSend = useMemo(
    () => input.trim().length > 0 && !sending && !expired,
    [input, sending, expired]
  );

  function getAgentSlug() {
    if (typeof window === "undefined") return "max";
    try {
      return new URL(window.location.href).searchParams.get("agent") || "max";
    } catch {
      return "max";
    }
  }

  function seedFirstMessage(agentName = "Max") {
    return [
      {
        role: "assistant",
        content:
          `Bonjour, je suis ${agentName} (Agent commercial). ` +
          "Dites-moi ce que vous vendez, à qui, et via quel canal (appel/email/LinkedIn), " +
          "et je vous propose un script + un plan de relance.",
      },
    ];
  }

  useEffect(() => {
    // auto-scroll
    if (!threadRef.current) return;
    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages.length, sending]);

  useEffect(() => {
    let mounted = true;

    async function boot() {
      setErrorMsg("");
      setChecking(true);

      // 1) session
      const {
        data: { session },
        error: sessErr,
      } = await supabase.auth.getSession();

      if (sessErr) {
        if (!mounted) return;
        setErrorMsg("Erreur session. Réessayez.");
        setChecking(false);
        setLoading(false);
        return;
      }

      if (!session) {
        window.location.href = "/login";
        return;
      }

      if (!mounted) return;
      setEmail(session.user.email || "");

      // 2) agent choisi via ?agent=
      const agentSlug = getAgentSlug();

      // Si table agents existe : on essaie de charger l’agent (sinon fallback)
      const { data: agentRow, error: agentErr } = await supabase
        .from("agents")
        .select("slug, name, description, avatar_url")
        .eq("slug", agentSlug)
        .maybeSingle();

      if (!mounted) return;

      if (!agentErr && agentRow?.slug) {
        setAgent({
          slug: agentRow.slug,
          name: agentRow.name || "Agent",
          description: agentRow.description || "",
          avatar_url: agentRow.avatar_url || "/images/logolong.png",
        });
        setMessages(seedFirstMessage(agentRow.name || "Agent"));
      } else {
        setAgent((prev) => ({ ...prev, slug: agentSlug }));
        setMessages(seedFirstMessage("Max"));
      }

      // 3) expiration (colonne profiles.duree ou profiles.expires_at)
      const userId = session.user.id;

      // On tente duree (timestamptz) d’abord, puis expires_at si tu l’as
      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("duree, expires_at")
        .eq("user_id", userId)
        .maybeSingle();

      if (!mounted) return;

      if (profErr) {
        setErrorMsg("Profil non accessible. Vérifiez les policies Supabase.");
      } else {
        const raw = prof?.duree || prof?.expires_at || null;
        const expiresAt = raw ? new Date(raw) : null;
        if (expiresAt && expiresAt.getTime() < Date.now()) setExpired(true);
      }

      setChecking(false);
      setLoading(false);

      // 4) écoute auth (logout)
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, newSession) => {
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

    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setSending(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userText,
          agent: agent.slug, // utile pour adapter côté API plus tard
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error || "Erreur API /api/chat");

      const reply = data?.reply || "Je n’ai pas pu générer une réponse.";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setErrorMsg("Erreur d’envoi. Vérifiez /api/chat.");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "Je rencontre un problème technique. Veuillez réessayer dans quelques instants.",
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
    return (
      <main style={styles.page}>
        <div style={styles.bg} aria-hidden="true">
          <div style={styles.bgLogo} />
          <div style={styles.bgVeils} />
        </div>
        <section style={styles.center}>
          <div style={styles.cardSmall}>
            <div style={styles.titleSmall}>Chargement…</div>
            <div style={styles.subtle}>Initialisation de votre agent.</div>
          </div>
        </section>
      </main>
    );
  }

  if (expired) {
    return (
      <main style={styles.page}>
        <div style={styles.bg} aria-hidden="true">
          <div style={styles.bgLogo} />
          <div style={styles.bgVeils} />
        </div>

        <a href="https://evidencia.me" style={styles.backLink}>
          ← Retour au site
        </a>

        <section style={styles.center}>
          <div style={styles.cardSmall}>
            <div style={styles.brandLine}>
              <img
                src="/images/logolong.png"
                alt="Evidenc’IA"
                style={styles.brandLogo}
              />
              <span style={styles.badge}>Accès expiré</span>
            </div>

            <h1 style={styles.h1}>Abonnement expiré</h1>
            <p style={styles.p}>
              Veuillez contacter Evidenc’IA pour renouveler votre abonnement.
            </p>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <a style={styles.pill} href="tel:+33665752635">Appeler</a>
              <a style={styles.pill} href="mailto:evidenciatech@gmail.com">Email</a>
              <button style={styles.pillGhost} onClick={logout}>Déconnexion</button>
            </div>

            <div style={{ marginTop: 14, ...styles.subtle }}>
              Utilisateur : {email || "—"}
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <div style={styles.bg} aria-hidden="true">
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
      </div>

      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.brandLogo} />
          <span style={styles.subtle}>
            {agent.description ? `${agent.description} — ` : ""}
            {agent.name}
          </span>
        </div>

        <div style={styles.topRight}>
          <span style={styles.userChip}>{email || "Connecté"}</span>
          <button onClick={logout} style={styles.btnGhost}>
            Déconnexion
          </button>
        </div>
      </header>

      <section style={styles.shell}>
        <div style={styles.chatCard}>
          {errorMsg ? <div style={styles.alert}>{errorMsg}</div> : null}

          <div ref={threadRef} style={styles.thread}>
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
                  <div style={styles.role}>{m.role === "user" ? "Vous" : agent.name}</div>
                  <div style={styles.text}>{m.content}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={styles.composer}>
            <textarea
              style={styles.textarea}
              placeholder="Écrivez votre message… (Entrée = envoyer, Maj+Entrée = saut de ligne)"
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

const styles = {
  page: {
    minHeight: "100vh",
    position: "relative",
    overflow: "hidden",
    fontFamily: "Segoe UI, Arial, sans-serif",
    color: "#eef2ff",
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
      "radial-gradient(900px 600px at 55% 42%, rgba(255,140,40,.22), rgba(0,0,0,0) 62%)," +
      "radial-gradient(900px 600px at 35% 55%, rgba(80,120,255,.18), rgba(0,0,0,0) 62%)," +
      "linear-gradient(to bottom, rgba(0,0,0,.62), rgba(0,0,0,.22) 30%, rgba(0,0,0,.22) 70%, rgba(0,0,0,.66))",
  },

  topbar: {
    position: "relative",
    zIndex: 1,
    padding: "16px 18px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderBottom: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.28)",
    backdropFilter: "blur(10px)",
  },

  topLeft: { display: "flex", alignItems: "center", gap: 12 },
  topRight: { display: "flex", alignItems: "center", gap: 10 },

  brandLogo: {
    height: 22,
    width: "auto",
    display: "block",
    filter: "drop-shadow(0 10px 26px rgba(0,0,0,.55))",
  },

  userChip: {
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(238,242,255,.85)",
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
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

  shell: {
    position: "relative",
    zIndex: 1,
    padding: 18,
    display: "grid",
    placeItems: "center",
  },

  chatCard: {
    width: "100%",
    maxWidth: 980,
    borderRadius: 26,
    border: "1px solid rgba(255,255,255,.12)",
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.60)",
    backdropFilter: "blur(14px)",
    overflow: "hidden",
  },

  alert: {
    margin: 14,
    padding: 12,
    borderRadius: 16,
    border: "1px solid rgba(255,140,40,.25)",
    background: "rgba(255,140,40,.10)",
    fontWeight: 900,
    fontSize: 13,
  },

  thread: {
    height: "calc(100vh - 220px)",
    minHeight: 420,
    overflowY: "auto",
    padding: 18,
    display: "grid",
    gap: 12,
  },

  bubbleRow: { display: "flex" },

  bubble: {
    maxWidth: 720,
    borderRadius: 18,
    padding: "12px 14px",
    border: "1px solid rgba(255,255,255,.12)",
    boxShadow: "0 14px 40px rgba(0,0,0,.35)",
    whiteSpace: "pre-wrap",
    lineHeight: 1.45,
  },

  bubbleUser: { background: "rgba(255,255,255,.10)" },
  bubbleBot: { background: "rgba(0,0,0,.35)" },

  role: {
    fontSize: 11,
    fontWeight: 900,
    opacity: 0.75,
    marginBottom: 6,
  },

  text: {
    fontSize: 14,
    fontWeight: 700,
    color: "rgba(238,242,255,.90)",
  },

  composer: {
    display: "flex",
    gap: 10,
    padding: 14,
    borderTop: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    backdropFilter: "blur(10px)",
  },

  textarea: {
    flex: 1,
    resize: "none",
    padding: "12px 14px",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.40)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 800,
    fontSize: 14,
    lineHeight: 1.4,
  },

  btn: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background:
      "linear-gradient(135deg, rgba(255,140,40,.22), rgba(80,120,255,.14))",
    color: "#eef2ff",
    fontWeight: 900,
    cursor: "pointer",
    minWidth: 110,
    boxShadow: "0 18px 45px rgba(0,0,0,.45)",
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

  center: {
    position: "relative",
    zIndex: 1,
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
  },

  cardSmall: {
    width: "100%",
    maxWidth: 560,
    borderRadius: 26,
    padding: 24,
    border: "1px solid rgba(255,255,255,.12)",
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.60)",
    backdropFilter: "blur(14px)",
  },

  titleSmall: { fontSize: 18, fontWeight: 900 },
  subtle: { fontSize: 12, fontWeight: 800, color: "rgba(238,242,255,.70)" },

  backLink: {
    position: "fixed",
    top: 16,
    left: 16,
    zIndex: 2,
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.45)",
    color: "#eef2ff",
    textDecoration: "none",
    fontWeight: 900,
    fontSize: 13,
    backdropFilter: "blur(10px)",
    boxShadow: "0 14px 40px rgba(0,0,0,.45)",
  },

  brandLine: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 10,
  },

  badge: {
    fontSize: 12,
    fontWeight: 900,
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
  },

  h1: { margin: "10px 0 6px", fontSize: 30, fontWeight: 900 },

  p: { margin: 0, fontSize: 14, fontWeight: 800, color: "rgba(238,242,255,.78)" },

  pill: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#eef2ff",
    textDecoration: "none",
    fontWeight: 900,
    cursor: "pointer",
  },

  pillGhost: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.35)",
    color: "#eef2ff",
    fontWeight: 900,
    cursor: "pointer",
  },
};
