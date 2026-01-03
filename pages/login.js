import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const e = url.searchParams.get("email");
      if (e) setEmail(e);
    } catch (_) {}
  }, []);

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

    window.location.href = "/chat";
  }

  return (
    <main style={styles.page}>
      {/* Background */}
      <div style={styles.bg} aria-hidden="true">
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
      </div>

      {/* Retour site */}
      <a href="https://evidencia.me" style={styles.backLink}>
        ← Retour au site
      </a>

      <section style={styles.shell}>
        <div style={styles.card}>
          <header style={styles.header}>
            <img
              src="/images/logolong.png"
              alt="Evidenc’IA"
              style={styles.logo}
            />
            <h1 style={styles.title}>Connexion</h1>
            <p style={styles.subtitle}>
              Accédez à vos agents Evidenc’IA.
            </p>
          </header>

          <form onSubmit={onSubmit} style={styles.form}>
            <div style={styles.field}>
              <label style={styles.label}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                style={styles.input}
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Mot de passe</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                style={styles.input}
              />
            </div>

            <button type="submit" disabled={loading} style={styles.button}>
              {loading ? "Connexion..." : "Connexion"}
            </button>

            {msg && <div style={styles.alert}>{msg}</div>}
          </form>

          <footer style={styles.footer}>
            © {new Date().getFullYear()} Evidenc’IA
          </footer>
        </div>
      </section>
    </main>
  );
}

/* ================== STYLES ================== */

const styles = {
  page: {
    minHeight: "100vh",
    position: "relative",
    overflow: "hidden",
    background: "#05060a",
    color: "#fff",
    fontFamily: "Segoe UI, Arial, sans-serif",
  },

  bg: {
    position: "absolute",
    inset: 0,
  },

  bgLogo: {
    position: "absolute",
    inset: 0,
    backgroundImage: "url('/images/logopc.png')",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
    backgroundSize: "contain",
    opacity: 0.08,
  },

  bgVeils: {
    position: "absolute",
    inset: 0,
    background:
      "linear-gradient(to bottom, rgba(0,0,0,.7), rgba(0,0,0,.4), rgba(0,0,0,.7))",
  },

  shell: {
    position: "relative",
    zIndex: 1,
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
  },

  backLink: {
    position: "fixed",
    top: 16,
    left: 16,
    zIndex: 2,
    color: "#fff",
    textDecoration: "none",
    fontWeight: 700,
    fontSize: 13,
  },

  card: {
    width: "100%",
    maxWidth: 420,
    padding: 24,
    borderRadius: 20,
    background: "rgba(0,0,0,.55)",
    backdropFilter: "blur(14px)",
    border: "1px solid rgba(255,255,255,.12)",
  },

  header: {
    textAlign: "center",
    marginBottom: 20,
  },

  logo: {
    width: 180,
    marginBottom: 12,
  },

  title: {
    fontSize: 28,
    fontWeight: 800,
    margin: 0,
  },

  subtitle: {
    fontSize: 14,
    opacity: 0.8,
  },

  form: {
    display: "grid",
    gap: 14,
  },

  field: {
    display: "grid",
    gap: 6,
  },

  label: {
    fontSize: 13,
    fontWeight: 600,
  },

  input: {
    padding: "12px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.2)",
    background: "rgba(0,0,0,.4)",
    color: "#fff",
  },

  button: {
    marginTop: 8,
    padding: "12px",
    borderRadius: 999,
    border: "none",
    fontWeight: 800,
    background:
      "linear-gradient(135deg, rgba(255,140,40,.4), rgba(80,120,255,.4))",
    color: "#fff",
    cursor: "pointer",
  },

  alert: {
    padding: 10,
    background: "rgba(255,80,80,.15)",
    borderRadius: 12,
    fontSize: 13,
    fontWeight: 700,
  },

  footer: {
    marginTop: 18,
    textAlign: "center",
    fontSize: 12,
    opacity: 0.6,
  },
};
