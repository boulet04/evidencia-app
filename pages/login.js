import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    // Pré-remplissage depuis ?email=...
    const url = new URL(window.location.href);
    const e = url.searchParams.get("email");
    if (e) setEmail(e);
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setMsg("");
    setLoading(true);

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    setLoading(false);

    if (error) {
      setMsg("Identifiants incorrects ou compte inexistant.");
      return;
    }

    // Redirection vers l'espace chat (qu'on créera juste après)
    window.location.href = "/chat";
  }

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Connexion</h1>
        <p style={styles.subtitle}>Accédez à votre agent Evidenc’IA.</p>

        <form onSubmit={onSubmit} style={styles.form}>
          <label style={styles.label}>Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={styles.input}
            placeholder="login@email.com"
            autoComplete="username"
          />

          <label style={styles.label}>Mot de passe</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            placeholder="••••••••••"
            autoComplete="current-password"
          />

          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? "Connexion..." : "Connexion"}
          </button>

          {msg ? <div style={styles.msg}>{msg}</div> : null}
        </form>

        <div style={styles.note}>
          Si vous n’avez pas encore de compte, contactez Evidenc’IA.
        </div>
      </div>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "#eef2ff",
    fontFamily: "Segoe UI, Arial, sans-serif"
  },
  card: {
    width: "100%",
    maxWidth: 420,
    padding: 22,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
    boxShadow: "0 14px 40px rgba(0,0,0,.45)",
    backdropFilter: "blur(10px)"
  },
  title: { margin: 0, fontSize: 28, fontWeight: 900 },
  subtitle: { marginTop: 6, marginBottom: 18, opacity: 0.8, fontWeight: 700 },
  form: { display: "grid", gap: 10 },
  label: { fontSize: 13, fontWeight: 800, opacity: 0.85 },
  input: {
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 700
  },
  button: {
    marginTop: 8,
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#eef2ff",
    fontWeight: 900,
    cursor: "pointer"
  },
  msg: {
    marginTop: 8,
    padding: 10,
    borderRadius: 12,
    border: "1px solid rgba(255,120,120,.35)",
    background: "rgba(255,120,120,.10)",
    fontWeight: 800
  },
  note: { marginTop: 14, fontSize: 12, opacity: 0.75, fontWeight: 700 }
};
