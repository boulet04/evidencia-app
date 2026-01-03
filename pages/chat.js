import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Chat() {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");

  const [agent, setAgent] = useState(null); // { slug, name, description, avatar_url }
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const threadRef = useRef(null);

  const canSend = useMemo(
    () => input.trim().length > 0 && !sending,
    [input, sending]
  );

  useEffect(() => {
    let mounted = true;

    async function boot() {
      setErrorMsg("");

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        window.location.href = "/login";
        return;
      }
      if (!mounted) return;

      setEmail(session.user.email || "");

      // slug agent depuis URL ?agent=
      const url = new URL(window.location.href);
      const raw = url.searchParams.get("agent");
      const slug = (raw ? decodeURIComponent(raw) : "").trim().toLowerCase();

      if (!slug) {
        window.location.href = "/agents";
        return;
      }

      // Agent depuis Supabase
      const { data: a, error } = await supabase
        .from("agents")
        .select("slug, name, description, avatar_url")
        .eq("slug", slug)
        .maybeSingle();

      if (!mounted) return;

      if (error || !a) {
        alert("Agent introuvable.");
        window.location.href = "/agents";
        return;
      }

      setAgent(a);

      // Message d'accueil propre
      setMessages([
        {
          role: "assistant",
          content: `Bonjour, je suis ${a.name}, ${a.description}. Comment puis-je vous aider ?`,
        },
      ]);

      setLoading(false);

      // logout => retour login
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

  useEffect(() => {
    // auto-scroll bas
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, loading]);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  async function sendMessage() {
    if (!agent || !canSend) return;

    const userText = input.trim();
    setInput("");
    setErrorMsg("");

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
        throw new Error(data?.error || "Erreur API");
      }

      const reply = data?.reply || "Réponse vide.";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setErrorMsg("Erreur interne. Réessayez plus tard.");
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

  if (loading || !agent) {
    return (
      <main style={styles.page}>
        <div style={styles.bg} aria-hidden="true">
          <div style={styles.bgLogo} />
          <div style={styles.bgVeils} />
        </div>
        <section style={styles.center}>
          <div style={styles.loadingCard}>
            <div style={{ fontWeight: 900, color: "#fff" }}>Chargement…</div>
            <div style={styles.loadingSub}>Initialisation de l’agent…</div>
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
        <div style={styles.left}>
          <img
            src="/images/logolong.png"
            alt="Evidenc’IA"
            style={styles.brandLogo}
          />

          <button
            style={styles.backBtn}
            onClick={() => (window.location.href = "/agents")}
            type="button"
          >
            ← Retour
          </button>

          <div style={styles.agentInfo}>
            <div style={styles.agentName}>{agent.name}</div>
            <div style={styles.agentRole}>{agent.description}</div>
          </div>
        </div>

        <div style={styles.right}>
          <span style={styles.userChip}>{email || "Connecté"}</span>
          <button onClick={logout} style={styles.btnGhost} type="button">
            Déconnexion
          </button>
        </div>
      </header>

      {/* Layout chat : pas de coupe en bas */}
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
                    ...(m.role === "user"
                      ? styles.bubbleUser
                      : styles.bubbleBot),
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
              placeholder="Votre message… (Entrée = envoyer, Maj+Entrée = saut de ligne)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
            />
            <button
              style={canSend ? styles.btn : styles.btnDisabled}
              onClick={sendMessage}
              disabled={!canSend}
              type="button"
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
    minHeight: "100dvh",
    position: "relative",
    overflow: "hidden",
    fontFamily: "Segoe UI, Arial, sans-serif",
    color: "#fff",
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
    zIndex: 2,
    padding: "14px 18px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderBottom: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.28)",
    backdropFilter: "blur(10px)",
  },

  left: { display: "flex", alignItems: "center", gap: 12, minWidth: 0 },

  right: { display: "flex", alignItems: "center", gap: 10 },

  brandLogo: {
    height: 26,
    width: "auto",
    display: "block",
    filter: "drop-shadow(0 10px 26px rgba(0,0,0,.55))",
  },

  backBtn: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.35)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  agentInfo: { display: "grid", gap: 2, minWidth: 0 },

  agentName: {
    fontWeight: 900,
    fontSize: 14,
    color: "#fff",
    lineHeight: 1.1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  agentRole: {
    fontWeight: 800,
    fontSize: 12,
    color: "rgba(255,255,255,.78)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  userChip: {
    fontSize: 12,
    fontWeight: 900,
    color: "#fff",
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
    maxWidth: 320,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  btnGhost: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.35)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },

  shell: {
    position: "relative",
    zIndex: 1,
    height: "calc(100dvh - 64px)", // topbar ~64px
    padding: 16,
    display: "grid",
    placeItems: "center",
  },

  chatCard: {
    width: "100%",
    maxWidth: 980,
    height: "100%",
    borderRadius: 26,
    border: "1px solid rgba(255,255,255,.12)",
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.60)",
    backdropFilter: "blur(14px)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },

  alert: {
    margin: 14,
    padding: 12,
    borderRadius: 16,
    border: "1px solid rgba(255,140,40,.25)",
    background: "rgba(255,140,40,.10)",
    fontWeight: 900,
    fontSize: 13,
    color: "#fff",
  },

  thread: {
    flex: 1,
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
    color: "#fff",
  },

  bubbleUser: {
    background: "rgba(255,255,255,.10)",
  },

  bubbleBot: {
    background: "rgba(0,0,0,.35)",
  },

  role: {
    fontSize: 11,
    fontWeight: 900,
    color: "rgba(255,255,255,.75)",
    marginBottom: 6,
  },

  text: {
    fontSize: 14,
    fontWeight: 700,
    color: "rgba(255,255,255,.92)",
  },

  composer: {
    padding: 14,
    borderTop: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    backdropFilter: "blur(10px)",
    display: "flex",
    gap: 10,
  },

  textarea: {
    flex: 1,
    resize: "none",
    padding: "12px 14px",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.40)",
    color: "#fff",
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
    color: "#fff",
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
    color: "rgba(255,255,255,.55)",
    fontWeight: 900,
    cursor: "not-allowed",
    minWidth: 110,
  },

  center: {
    position: "relative",
    zIndex: 1,
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
    padding: 24,
  },

  loadingCard: {
    padding: "14px 18px",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.45)",
    color: "#fff",
    fontWeight: 900,
    backdropFilter: "blur(12px)",
  },

  loadingSub: {
    marginTop: 6,
    color: "rgba(255,255,255,.78)",
    fontWeight: 800,
    fontSize: 12,
  },
};
