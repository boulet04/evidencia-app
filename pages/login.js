import { useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

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

    window.location.href = "/agents";
  }

  return (
    <main style={styles.page}>
      {/* Fond */}
      <div style={styles.bg} aria-hidden="true">
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
      </div>

      <a href="https://evidencia.me" style={styles.backLink}>← Retour au site</a>

      <section style={styles.shell}>
        <div style={styles.card}>
          <header style={styles.header}>
            <img src="/images/logolong.png" alt="logo" style={styles.logo} />
            <h1 style={styles.title}>Connexion</h1>
            <p style={styles.subtitle}>Accédez à vos agents Evidenc’IA.</p>
          </header>

          <form onSubmit={onSubmit} style={styles.form}>

            <label style={styles.label}>Email</label>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={styles.input}
              required
            />

            <label style={styles.label}>Mot de passe</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.input}
              required
            />

            {msg && <div style={styles.alert}>{msg}</div>}

            <button type="submit" disabled={loading} style={styles.button}>
              {loading ? "Connexion…" : "Connexion"}
            </button>

          </form>

          <footer style={styles.footer}>
            © {new Date().getFullYear()} Evidenc’IA
          </footer>
        </div>
      </section>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "#fff",
    position: "relative",
    overflow: "hidden",
    fontFamily: "Segoe UI, Arial, sans-serif",
  },

  bg: { position: "absolute", inset: 0 },

  bgLogo: {
    position: "absolute",
    inset: 0,
    background: "url('/images/logopc.png') center/contain no-repeat",
    opacity: 0.08,
  },

  bgVeils: {
    position: "absolute",
    inset: 0,
    background:
      "linear-gradient(to bottom, rgba(0,0,0,.7), rgba(0,0,0,.3), rgba(0,0,0,.7))",
  },

  backLink: {
    position: "absolute",
    top: 20,
    left: 20,
    color: "#fff",
    fontWeight: 700,
    textDecoration: "none",
    zIndex: 3,
  },

  shell: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 20,
  },

  card: {
    width: "100%",
    maxWidth: 420,
    padding: 24,
    borderRadius: 22,
    background: "rgba(0,0,0,.55)",
    backdropFilter: "blur(12px)",
    border: "1px solid rgba(255,255,255,.12)",
  },

  header: { textAlign: "center", marginBottom: 18 },

  logo: { width: 180, marginBottom: 12 },

  title: { fontSize: 28, fontWeight: 900 },

  subtitle: { opacity: 0.8, marginBottom: 20 },

  form: { display: "grid", gap: 12 },

  label: { fontWeight: 700 },

  input: {
    padding: "12px 14px",
    background: "rgba(255,255,255,.08)",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.2)",
    color: "#fff",
  },

  button: {
    padding: "12px",
    background: "linear-gradient(135deg,rgba(255,140,40,.4),rgba(80,120,255,.4))",
    borderRadius: 12,
    border: "none",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    marginTop: 8,
  },

  alert: {
    background: "rgba(255,80,80,.2)",
    padding: 10,
    borderRadius: 12,
    border: "1px solid rgba(255,80,80,.4)",
    fontWeight: 700,
  },

  footer: {
    marginTop: 16,
    opacity: 0.6,
    textAlign: "center",
    fontSize: 12,
  },
};
