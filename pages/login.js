import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  // Optionnel : préremplir l’email via ?email=
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
      {/* Fond “charte” : logo translucide + voiles */}
      <div style={styles.bg} aria-hidden="true">
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
      </div>

      {/* Bouton retour site vitrine */}
      <a href="https://evidencia.me" style={styles.backLink}>
        ← Retour au site
      </a>

      <section style={styles.shell}>
        <div style={styles.card}>
          <header style={styles.header}>
            <div style={styles.brandLine}>
              <span style={styles.brand}>Evidenc’IA</span>
              <span style={styles.brandSub}>Accès client</span>
            </div>
            <h1 style={styles.title}>Connexion</h1>
            <p style={styles.subtitle}>
              Connectez-vous pour accéder à vos agents Evidenc’IA.
            </p>
          </header>

          <form onSubmit={onSubmit} style={styles.form}>
            <div style={styles.field}>
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
            </div>

            <div style={styles.field}>
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
            </div>

            <button type="submit" disabled={loading} style={styles.button}>
              {loading ? "Connexion..." : "Connexion"}
            </button>

            {msg ? <div style={styles.alert}>{msg}</div> : null}

            <div style={styles.note}>
              Si vous n’avez pas encore de compte, contactez Evidenc’IA.
            </div>
          </form>

          <footer style={styles.footer}>
            © {new Date().getFullYear()} Evidenc’IA — Tous droits réservés
          </footer>
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

  // --- Background layer ---
  bg: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
  },

  // Logo en fond (plus visible, logo entier)
  bgLogo: {
    position: "absolute",
    inset: 0,
    backgroundImage: "url('/images/logopc.png')",
    backgroundRepeat: "no-repeat",
    backgroundSize: "contain",
    backgroundPosition: "center",
    opacity: 0.5, // ↑ PLUS VISIBLE (avant 0.16)
    filter: "brightness(1.18) contrast(1.12) saturate(1.10)",
    transform: "scale(1.02)",
  },

  // Voiles + halos (VOILE ASSOUPLI pour laisser voir le logo)
  bgVeils: {
    position: "absolute",
    inset: 0,
    background:
      // halo orange (un peu plus présent)
      "radial-gradient(900px 600px at 55% 42%, rgba(255,140,40,.26), rgba(0,0,0,0) 62%)," +
      // halo bleu
      "radial-gradient(900px 600px at 35% 55%, rgba(80,120,255,.18), rgba(0,0,0,0) 62%)," +
      // voile haut/bas : allégé (c'était lui qui masquait le logo)
      "linear-gradient(to bottom, rgba(0,0,0,.45), rgba(0,0,0,.16) 30%, rgba(0,0,0,.16) 70%, rgba(0,0,0,.50))",
  },

  // --- Layout ---
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
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.40)",
    color: "#eef2ff",
    textDecoration: "none",
    fontWeight: 900,
    fontSize: 13,
    backdropFilter: "blur(10px)",
    boxShadow: "0 14px 40px rgba(0,0,0,.45)",
  },

  // --- Card (un peu plus opaque pour garder la lisibilité) ---
  card: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 26,
    padding: 24,
    border: "1px solid rgba(255,255,255,.12)",
    background:
      "linear-gradient(135deg, rgba(0,0,0,.72), rgba(0,0,0,.52))",
    boxShadow: "0 24px 70px rgba(0,0,0,.60)",
    backdropFilter: "blur(14px)",
  },

  header: {
    marginBottom: 16,
  },

  brandLine: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 10,
  },

  brand: {
    fontWeight: 900,
    letterSpacing: 0.3,
    fontSize: 14,
    padding: "6px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
  },

  brandSub: {
    fontWeight: 900,
    fontSize: 12,
    color: "rgba(238,242,255,.72)",
  },

  title: {
    margin: 0,
    fontSize: 34,
    fontWeight: 900,
    textShadow: "0 10px 30px rgba(0,0,0,.55)",
    letterSpacing: 0.2,
  },

  subtitle: {
    margin: "8px 0 0",
    fontSize: 14,
    fontWeight: 800,
    color: "rgba(238,242,255,.78)",
    lineHeight: 1.45,
  },

  // --- Form ---
  form: {
    display: "grid",
    gap: 12,
    marginTop: 18,
  },

  field: { display: "grid", gap: 8 },

  label: {
    fontSize: 13,
    fontWeight: 900,
    color: "rgba(238,242,255,.88)",
  },

  input: {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.45)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 800,
    fontSize: 14,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)",
  },

  button: {
    marginTop: 6,
    padding: "12px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background:
      "linear-gradient(135deg, rgba(255,140,40,.28), rgba(80,120,255,.16))",
    color: "#eef2ff",
    fontWeight: 900,
    fontSize: 14,
    cursor: "pointer",
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
  },

  alert: {
    padding: 12,
    borderRadius: 16,
    border: "1px solid rgba(255,140,40,.28)",
    background: "rgba(255,140,40,.12)",
    fontWeight: 900,
    fontSize: 13,
  },

  note: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: 800,
    color: "rgba(238,242,255,.74)",
  },

  footer: {
    marginTop: 18,
    paddingTop: 14,
    borderTop: "1px solid rgba(255,255,255,.10)",
    textAlign: "center",
    fontSize: 12,
    fontWeight: 800,
    color: "rgba(238,242,255,.62)",
  },
};
