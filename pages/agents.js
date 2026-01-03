import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Agents() {
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState([]);
  const [email, setEmail] = useState("");

  useEffect(() => {
    let mounted = true;

    async function boot() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = "/login";
        return;
      }
      if (!mounted) return;

      setEmail(session.user.email || "");

      const { data, error } = await supabase
        .from("agents")
        .select("id, slug, name, description, avatar_url")
        .order("name", { ascending: true });

      if (!mounted) return;
      setAgents(error ? [] : data || []);
      setLoading(false);
    }

    boot();
    return () => { mounted = false; };
  }, []);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.center}>Chargement…</div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      {/* BACKGROUND */}
      <div style={styles.bg} aria-hidden="true">
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
      </div>

      {/* BOUTON RETOUR */}
      <button
        style={styles.backBtn}
        onClick={() => window.location.href = "/chat"}
      >
        ← Retour
      </button>

      {/* TOP BAR */}
      <header style={styles.topbar}>
        <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.brandLogo} />
        <div style={styles.topRight}>
          <span style={styles.userChip}>{email}</span>
          <button onClick={logout} style={styles.btnGhost}>Déconnexion</button>
        </div>
      </header>

      <section style={styles.shell}>
        <h1 style={styles.h1}>Choisissez votre agent</h1>
        <p style={styles.p}>Cliquez sur un agent pour ouvrir son espace.</p>

        <div style={styles.grid}>
          {agents.map((a) => (
            <button
              key={a.id}
              style={styles.card}
              onClick={() =>
                window.location.href = `/chat?agent=${encodeURIComponent(a.slug)}`
              }
            >
              {/* AVATAR BIEN VISIBLE */}
              <img
                src={a.avatar_url}
                alt={a.name}
                style={styles.avatar}
              />

              <div style={styles.meta}>
                <div style={styles.name}>{a.name}</div>
                <div style={styles.desc}>{a.description}</div>
              </div>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

/* ================= STYLES ================= */

const styles = {
  page: {
    minHeight: "100vh",
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
      "linear-gradient(to bottom, rgba(0,0,0,.65), rgba(0,0,0,.25) 30%, rgba(0,0,0,.25) 70%, rgba(0,0,0,.70))",
  },

  /* RETOUR */
  backBtn: {
    position: "fixed",
    top: 16,
    left: 16,
    zIndex: 3,
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.2)",
    background: "rgba(0,0,0,.45)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    backdropFilter: "blur(10px)",
  },

  topbar: {
    position: "relative",
    zIndex: 1,
    padding: "16px 18px",
    display: "flex",
    justifyContent: "space-between",
    borderBottom: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.25)",
    backdropFilter: "blur(10px)",
  },

  brandLogo: { height: 22 },

  topRight: { display: "flex", gap: 10, alignItems: "center" },

  userChip: {
    fontSize: 12,
    fontWeight: 900,
    padding: "8px 12px",
    borderRadius: 999,
    background: "rgba(0,0,0,.35)",
    border: "1px solid rgba(255,255,255,.12)",
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
    padding: 24,
    maxWidth: 1100,
    margin: "0 auto",
  },

  h1: { fontSize: 32, fontWeight: 900 },
  p: { marginBottom: 20, fontSize: 14, fontWeight: 800, opacity: 0.8 },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))",
    gap: 16,
  },

  card: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: 18,
    borderRadius: 24,
    border: "1px solid rgba(255,255,255,.18)",
    background: "rgba(0,0,0,.55)",
    backdropFilter: "blur(14px)",
    cursor: "pointer",
  },

  /* AVATAR CORRIGÉ */
  avatar: {
    width: 72,
    height: 72,
    borderRadius: "50%",
    objectFit: "cover",
    border: "2px solid rgba(255,255,255,.35)",
    flexShrink: 0,
  },

  meta: { display: "grid", gap: 6 },

  name: {
    fontSize: 18,
    fontWeight: 900,
    color: "#fff",
    textShadow: "0 2px 12px rgba(0,0,0,.6)",
  },

  desc: {
    fontSize: 13,
    fontWeight: 800,
    color: "rgba(238,242,255,.75)",
  },

  center: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
  },
};
