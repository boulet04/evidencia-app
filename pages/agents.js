import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Agents() {
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState([]);
  const [email, setEmail] = useState("");

  useEffect(() => {
    let mounted = true;

    async function boot() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

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
    return () => {
      mounted = false;
    };
  }, []);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.bg} aria-hidden="true">
          <div style={styles.bgLogo} />
          <div style={styles.bgVeils} />
        </div>
        <section style={styles.center}>
          <div style={styles.loadingCard}>Chargement…</div>
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
        <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.brandLogo} />

        <div style={styles.topRight}>
          <span style={styles.userChip}>{email || "Connecté"}</span>
          <button onClick={logout} style={styles.btnGhost}>
            Déconnexion
          </button>
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
              onClick={() => (window.location.href = `/chat?agent=${encodeURIComponent(a.slug)}`)}
            >
              <div style={styles.avatarWrap}>
                {a.avatar_url ? (
                  <img src={a.avatar_url} alt={a.name} style={styles.avatar} />
                ) : (
                  <div style={styles.avatarFallback}>{(a.name || "A")[0]}</div>
                )}
              </div>

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

const styles = {
  page: {
    minHeight: "100dvh",
    position: "relative",
    overflow: "hidden",
    fontFamily: "Segoe UI, Arial, sans-serif",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "#fff",
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
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.28)",
    backdropFilter: "blur(10px)",
  },

  brandLogo: {
    height: 30,
    width: "auto",
    display: "block",
    filter: "drop-shadow(0 10px 26px rgba(0,0,0,.55))",
  },

  topRight: { display: "flex", alignItems: "center", gap: 10 },

  userChip: {
    fontSize: 12,
    fontWeight: 900,
    color: "#fff",
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
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },

  shell: {
    position: "relative",
    zIndex: 1,
    padding: 20,
    maxWidth: 1100,
    margin: "0 auto",
  },

  h1: { margin: "18px 0 6px", fontSize: 38, fontWeight: 900, color: "#fff" },

  p: {
    margin: "0 0 18px",
    fontSize: 14,
    fontWeight: 800,
    color: "rgba(255,255,255,.80)",
  },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))",
    gap: 18,
  },

  card: {
    textAlign: "left",
    display: "flex",
    gap: 14,
    padding: 18,
    borderRadius: 22,
    border: "1px solid rgba(255,255,255,.12)",
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 18px 55px rgba(0,0,0,.45)",
    backdropFilter: "blur(12px)",
    cursor: "pointer",
  },

  avatarWrap: { width: 64, height: 64, flex: "0 0 64px" },

  avatar: {
    width: 64,
    height: 64,
    borderRadius: "50%",
    objectFit: "cover",
    objectPosition: "top center",
    border: "1px solid rgba(255,255,255,.14)",
    boxShadow: "0 14px 40px rgba(0,0,0,.35)",
    background: "rgba(0,0,0,.25)",
  },

  avatarFallback: {
    width: 64,
    height: 64,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.08)",
    color: "#fff",
    fontWeight: 900,
  },

  meta: { display: "grid", gap: 6 },

  name: { fontSize: 18, fontWeight: 900, color: "#fff" },

  desc: {
    fontSize: 13,
    fontWeight: 800,
    color: "rgba(255,255,255,.78)",
    lineHeight: 1.35,
  },

  center: { minHeight: "100dvh", display: "grid", placeItems: "center" },

  loadingCard: {
    padding: "14px 18px",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.45)",
    color: "#fff",
    fontWeight: 900,
    backdropFilter: "blur(12px)",
  },
};
