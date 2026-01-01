import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  // Permet (optionnel) de pré-remplir l'email si tu ajoutes ?email=xxx
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const e = url.searchParams.get("email");
      if (e) setEmail(e);
    } catch (_) {}
  }, []);

  const year = useMemo(() => new Date().getFullYear(), []);

  async function onSubmit(e) {
    e.preventDefault();
    setMsg("");
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setMsg("Identifiants incorrects ou compte inexistant.");
      return;
    }

    // Redirection après connexion
    window.location.href = "/chat";
  }

  return (
    <main style={styles.page}>
      {/* CTA retour site */}
      <a href="https://evidencia.me" style={styles.backLink} aria-label="Retour au site Evidenc’IA">
        <span style={styles.backIcon} aria-hidden="true">←</span>
        Retour au site
      </a>

      <section style={styles.shell}>
        <div style={styles.card}>
          <header style={styles.header}>
            <div style={styles.brandRow}>
              <div style={styles.brandPill}>Evidenc’IA</div>
              <div style={styles.brandDot} aria-hidden="true" />
            </div>

            <h1 style={styles.title}>Connexion</h1>
            <p style={styles.subtitle}>
              Accédez à vos agents IA en toute sécurité.
            </p>
          </header>

          <form onSubmit={onSubmit} style={styles.form}>
            <div style={styles.field}>
              <label style={styles.label}>Email</label>
              <input
                style={styles.input}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="login@email.com"
                autoComplete="username"
                required
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Mot de passe</label>
              <input
                style={styles.input}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
                autoComplete="current-password"
                required
              />
            </div>

            <button type="submit" style={styles.button} disabled={loading}>
              {loading ? "Connexion..." : "Connexion"}
            </button>

            {msg ? <div style={styles.alert}>{msg}</div> : null}

            <div style={styles.help}>
              Si vous n’avez pas encore de compte, contactez Evidenc’IA.
            </div>
          </form>

          <footer style={styles.footer}>
            <span>© {year} Evidenc’IA</span>
            <span style={styles.sep} aria-hidden="true">•</span>
            <a
              href="mailto:evidenciatech@gmail.com"
              style={styles.footerLink}
              aria-label="Contacter Evidenc’IA par email"
            >
              evidenciatech@gmail.com
            </a>
          </footer>
        </div>
      </section>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    padding: 24,
    color: "#eef2ff",
    fontFamily: "Segoe UI, Arial, sans-serif",
    background:
      "radial-gradient(1100px 700px at 50% 0%, rgba(255,140,40,.10), transparent 60%)," +
      "radial-gradient(1000px 700px at 20% 40%, rgba(80,120,255,.10), transparent 60%)," +
      "linear-gradient(135deg,#05060a,#0a0d16)",
    position: "relative",
    overflow: "hidden",
  },

  backLink: {
    position: "fixed",
    top: 16,
    left: 16,
    zIndex: 10000,
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.35)",
    color: "#eef2ff",
    textDecoration: "none",
    fontWeight: 900,
    fontSize: 13,
    backdropFilter: "blur(10px)",
    boxShadow: "0 14px 40px rgba(0,0,0,.45)",
    transition: "transform .16s ease, background .16s ease, border-color .16s ease",
  },

  backIcon: { fontSize: 16, lineHeight: 1, opacity: 0.95 },

  shell: {
    minHeight: "calc(100vh - 48px)",
    display: "grid",
    placeItems: "center",
  },

  card: {
    width: "100%",
    maxWidth: 480,
    borderRadius: 22,
    padding: 22,
    border: "1px solid rgba(255,255,255,.10)",
    background:
      "radial-gradient(900px 620px at 55% 10%, rgba(80,120,255,.18), rgba(0,0,0,0) 60%)," +
      "radial-gradient(900px 620px at 78% 18%, rgba(255,140,40,.20), rgba(0,0,0,0) 62%)," +
      "linear-gradient(135deg, rgba(255,255,255,.03), rgba(255,255,255,.01))",
    boxShadow: "0 24px 70px rgba(0,0,0,.55)",
    backdropFilter: "blur(10px)",
  },

  header: { marginBottom: 14 },

  brandRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },

  brandPill: {
    display: "inline-flex",
    alignItems: "center",
    padding: "6px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.35)",
    fontWeight: 900,
    fontSize: 12,
    letterSpacing: 0.3,
  },

  brandDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: "rgba(255,140,40,.85)",
    boxShadow: "0 0 0 6px rgba(255,140,40,.12)",
  },

  title: {
    margin: "0 0 6px",
    fontSize: 32,
    fontWeight: 900,
    letterSpacing: 0.2,
    textShadow: "0 10px 30px rgba(0,0,0,.55)",
  },

  subtitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 800,
    opacity: 0.78,
    lineHeight: 1.4,
  },

  form: {
    display: "grid",
    gap: 12,
    marginTop: 16,
  },

  field: { display: "grid", gap: 8 },

  label: {
    fontSize: 13,
    fontWeight: 900,
    opacity: 0.85,
  },

  input: {
    width: "100%",
    padding: "11px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 800,
    fontSize: 14,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)",
  },

  button: {
    marginTop: 6,
    padding: "11px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.10)",
    color: "#eef2ff",
    fontWeight: 900,
    fontSize: 14,
    cursor: "pointer",
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
    transition: "transform .16s ease, background .16s ease",
  },

  alert: {
    padding: 10,
    borderRadius: 14,
    border: "1px solid rgba(255,140,40,.25)",
    background: "rgba(255,140,40,.10)",
    fontWeight: 900,
    fontSize: 13,
  },

  help: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: 800,
    opacity: 0.78,
  },

  footer: {
    marginTop: 18,
    paddingTop: 14,
    borderTop: "1px solid rgba(255,255,255,.10)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    fontSize: 12,
    fontWeight: 800,
    opacity: 0.8,
    flexWrap: "wrap",
  },

  sep: { opacity: 0.7 },

  footerLink: {
    color: "#eef2ff",
    textDecoration: "none",
    borderBottom: "1px solid rgba(255,255,255,.18)",
    paddingBottom: 1,
  },
};
