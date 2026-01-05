import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Agents() {
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState([]);
  const [email, setEmail] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

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

      // Lire rôle dans profiles
      const { data: p, error: pErr } = await supabase
        .from("profiles")
        .select("role")
        .eq("user_id", session.user.id)
        .maybeSingle();

      if (!mounted) return;
      setIsAdmin(!pErr && p?.role === "admin");

      const { data, error } = await supabase
        .from("agents")
        .select("*")
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
        <div style={styles.center}>Chargement…</div>
      </main>
    );
  }

  return (
    // IMPORTANT: wrapper "globalFix" = correctif B appliqué
    <main style={{ ...styles.page, ...styles.globalFix }}>
      <div style={styles.bg} aria-hidden="true">
        <div style={styles.bgLogo} />
        <div style={styles.bgVeils} />
      </div>

      <header style={styles.topbar}>
        <img
          src="/images/logolong.png"
          alt="Evidenc’IA"
          style={styles.brandLogo}
        />

        <div style={styles.topRight}>
          <span style={styles.userChip}>{email}</span>

          {isAdmin ? (
            <button
              type="button"
              onClick={() => (window.location.href = "/admin")}
              style={styles.btnGhost}
            >
              Console admin
            </button>
          ) : null}

          <button type="button" onClick={logout} style={styles.btnGhost}>
            Déconnexion
          </button>
        </div>
      </header>

      <section style={styles.shell}>
        <h1 style={styles.h1}>Choisissez votre agent</h1>
        <p style={styles.p}>Cliquez sur un agent pour ouvrir son espace.</p>

        <div style={styles.grid}>
          {agents.map((a) => {
            const src = (a?.avatar_url || "").trim() || `/images/${a.slug}.png`;

            return (
              <button
                key={a.id}
                type="button"
                style={styles.card}
                onClick={() => (window.location.href = `/chat?agent=${a.slug}`)}
              >
                <div style={styles.avatarWrap}>
                  <img
                    src={src}
                    alt={a.name}
                    style={styles.avatar}
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.onerror = null;
                      e.currentTarget.src = "/images/logopc.png";
                    }}
                  />
                </div>

                <div style={styles.meta}>
                  <div style={styles.name}>{a.name}</div>
                  <div style={styles.desc}>{a.description}</div>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}

/**
 * Correctif "B" renforcé :
 * - On force l'héritage de couleur sur les zones problématiques.
 * - On neutralise le style navigateur des <button> (WebKit mobile peut forcer du noir).
 */
const styles = {
  page: {
    minHeight: "100vh",
    position: "relative",
    overflow: "hidden",
    fontFamily: "Segoe UI, Arial, sans-serif",
    color: "#eef2ff",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
  },

  // Wrapper global pour forcer l'héritage
  globalFix: {
    color: "#eef2ff",
  },

  bg: { position: "absolute", inset: 0, zIndex: 0 },

  bgLogo: {
    position: "absolute",
    inset: 0,
    backgroundImage: "url('/images/logopc.png')",
    backgroundSize: "contain",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    opacity: 0.05,
  },

  bgVeils: {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(900px 600px at 55% 42%, rgba(255,140,40,.22), transparent 62%)," +
      "radial-gradient(900px 600px at 35% 55%, rgba(80,120,255,.18), transparent 62%)," +
      "linear-gradient(to bottom, rgba(0,0,0,.62), rgba(0,0,0,.22), rgba(0,0,0,.66))",
  },

  topbar: {
    position: "relative",
    zIndex: 2,
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    borderBottom: "1px solid rgba(255,255,255,.1)",
  },

  brandLogo: { height: 32 },

  topRight: { display: "flex", alignItems: "center", gap: 10 },

  userChip: {
    padding: "8px 12px",
    background: "rgba(255,255,255,.12)",
    borderRadius: 999,
    fontWeight: 800,
    color: "inherit",
    WebkitTextFillColor: "currentColor",
  },

  btnGhost: {
    padding: "10px 14px",
    borderRadius: 999,
    background: "rgba(255,255,255,.1)",
    border: "1px solid rgba(255,255,255,.2)",
    cursor: "pointer",
    fontWeight: 900,

    // HARDENING (anti-texte noir mobile)
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    appearance: "none",
    WebkitAppearance: "none",
    outline: "none",
  },

  shell: {
    position: "relative",
    zIndex: 1,
    padding: 20,
    maxWidth: 1100,
    margin: "0 auto",
  },

  h1: { fontSize: 32, fontWeight: 900, marginBottom: 6, color: "inherit" },
  p: { opacity: 0.8, marginBottom: 20, color: "inherit" },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 20,
  },

  card: {
    display: "flex",
    gap: 14,
    padding: 18,
    background: "rgba(0,0,0,.45)",
    borderRadius: 20,
    backdropFilter: "blur(10px)",
    border: "1px solid rgba(255,255,255,.12)",
    cursor: "pointer",
    textAlign: "left",

    // HARDENING (anti-texte noir mobile)
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    appearance: "none",
    WebkitAppearance: "none",
    outline: "none",
  },

  avatarWrap: { width: 64, height: 64, flex: "0 0 64px" },

  avatar: {
    width: "100%",
    height: "100%",
    borderRadius: "50%",
    objectFit: "cover",
    objectPosition: "top",
    display: "block",
  },

  meta: { display: "grid", gap: 4, color: "inherit" },
  name: {
    fontSize: 18,
    fontWeight: 900,
    color: "inherit",
    WebkitTextFillColor: "currentColor",
  },
  desc: {
    opacity: 0.75,
    fontWeight: 700,
    color: "inherit",
    WebkitTextFillColor: "currentColor",
  },

  center: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    fontSize: 20,
    color: "#eef2ff",
  },
};
