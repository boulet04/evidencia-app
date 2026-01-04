import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null); // { user_id, role, email }
  const [users, setUsers] = useState([]); // profiles list
  const [agents, setAgents] = useState([]); // agents list
  const [userAgents, setUserAgents] = useState([]); // mapping rows
  const [selectedUserId, setSelectedUserId] = useState("");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const isAdmin = useMemo(() => me?.role === "admin", [me]);

  const usersFiltered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return users;
    return users.filter((u) => {
      const email = (u.email || "").toLowerCase();
      const uid = (u.user_id || "").toLowerCase();
      return email.includes(s) || uid.includes(s);
    });
  }, [users, q]);

  const selectedUser = useMemo(
    () => users.find((u) => u.user_id === selectedUserId) || null,
    [users, selectedUserId]
  );

  const assignedSet = useMemo(() => {
    const set = new Set();
    for (const row of userAgents) {
      if (row.user_id === selectedUserId) set.add(row.agent_id);
    }
    return set;
  }, [userAgents, selectedUserId]);

  useEffect(() => {
    let mounted = true;

    async function boot() {
      setMsg("");
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = "/login";
        return;
      }

      // Profil du user connecté
      const { data: myProfile1, error: myErr1 } = await supabase
        .from("profiles")
        .select("user_id, role, email")
        .eq("user_id", session.user.id)
        .maybeSingle();

      // ✅ CORRECTIF : si profil absent, on tente de le créer (avec id généré) puis on le relit
      let myProfile = myProfile1;

      if (!myErr1 && !myProfile) {
        const newRow = {
          user_id: session.user.id,
          email: session.user.email,
          role: "user",
        };

        const newId =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : null;

        if (newId) newRow.id = newId;

        const { error: insErr } = await supabase.from("profiles").insert(newRow);

        if (insErr) {
          if (!mounted) return;
          setLoading(false);
          setMsg(`Création du profil impossible : ${insErr.message}`);
          return;
        }

        const { data: myProfile2, error: myErr2 } = await supabase
          .from("profiles")
          .select("user_id, role, email")
          .eq("user_id", session.user.id)
          .maybeSingle();

        if (myErr2) {
          if (!mounted) return;
          setLoading(false);
          setMsg(`Lecture du profil impossible : ${myErr2.message}`);
          return;
        }

        myProfile = myProfile2 || null;
      }

      if (!mounted) return;

      if (myErr1 || !myProfile) {
        setLoading(false);
        setMsg(myErr1 ? `Lecture du profil impossible : ${myErr1.message}` : "Profil introuvable (table profiles).");
        return;
      }

      setMe(myProfile);

      if (myProfile.role !== "admin") {
        setLoading(false);
        setMsg("Accès refusé : vous n’êtes pas admin.");
        return;
      }

      // Charger users
      const { data: u, error: uErr } = await supabase
        .from("profiles")
        .select("user_id, email, role")
        .order("email", { ascending: true });

      // Charger agents
      const { data: a, error: aErr } = await supabase
        .from("agents")
        .select("id, slug, name, description, avatar_url")
        .order("name", { ascending: true });

      // Charger assignations (user_agents)
      const { data: ua, error: uaErr } = await supabase
        .from("user_agents")
        .select("user_id, agent_id, created_at")
        .order("created_at", { ascending: false });

      if (!mounted) return;

      setUsers(uErr ? [] : (u || []));
      setAgents(aErr ? [] : (a || []));
      setUserAgents(uaErr ? [] : (ua || []));

      // Sélection auto du premier user non-admin si possible
      const firstUser =
        (u || []).find((x) => x.role !== "admin") || (u || [])[0];
      setSelectedUserId(firstUser?.user_id || "");

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

  async function toggleAgent(agentId) {
    if (!selectedUserId || !agentId) return;
    if (!isAdmin) return;

    setSaving(true);
    setMsg("");

    const already = assignedSet.has(agentId);

    try {
      if (already) {
        // Désassigner
        const { error } = await supabase
          .from("user_agents")
          .delete()
          .eq("user_id", selectedUserId)
          .eq("agent_id", agentId);

        if (error) throw error;

        setUserAgents((prev) =>
          prev.filter((r) => !(r.user_id === selectedUserId && r.agent_id === agentId))
        );
      } else {
        // Assigner
        const { data, error } = await supabase
          .from("user_agents")
          .insert({ user_id: selectedUserId, agent_id: agentId })
          .select("user_id, agent_id, created_at")
          .single();

        if (error) throw error;

        setUserAgents((prev) => [data, ...prev]);
      }
    } catch (e) {
      setMsg(e?.message || "Erreur lors de la mise à jour.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.card}>
          <div style={styles.h1}>Backoffice</div>
          <div style={styles.p}>Chargement…</div>
        </div>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main style={styles.page}>
        <div style={styles.card}>
          <div style={styles.h1}>Backoffice</div>
          <div style={styles.alert}>{msg || "Accès refusé."}</div>
          <button style={styles.btnGhost} onClick={() => (window.location.href = "/agents")}>
            Retour aux agents
          </button>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <header style={styles.topbar}>
        <div style={styles.brand}>Backoffice Evidenc’IA</div>
        <div style={styles.topRight}>
          <span style={styles.chip}>{me?.email || "admin"}</span>
          <button style={styles.btnGhost} onClick={logout}>Déconnexion</button>
        </div>
      </header>

      <section style={styles.layout}>
        {/* USERS */}
        <aside style={styles.panel}>
          <div style={styles.panelHeader}>
            <div style={styles.panelTitle}>Utilisateurs</div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher email / id…"
              style={styles.search}
            />
          </div>

          <div style={styles.list}>
            {usersFiltered.map((u) => {
              const active = u.user_id === selectedUserId;
              return (
                <button
                  key={u.user_id}
                  onClick={() => setSelectedUserId(u.user_id)}
                  style={{ ...styles.item, ...(active ? styles.itemActive : null) }}
                >
                  <div style={styles.itemTop}>
                    <div style={styles.itemEmail}>{u.email || "(email non renseigné)"}</div>
                    <div style={styles.badge}>{u.role}</div>
                  </div>
                  <div style={styles.itemId}>{u.user_id}</div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ASSIGN */}
        <div style={styles.panel}>
          <div style={styles.panelHeader}>
            <div>
              <div style={styles.panelTitle}>Assignation agents</div>
              <div style={styles.sub}>
                {selectedUser ? (
                  <>
                    <div><b>Utilisateur :</b> {selectedUser.email || selectedUser.user_id}</div>
                    <div><b>user_id :</b> {selectedUser.user_id}</div>
                  </>
                ) : (
                  "Sélectionne un utilisateur."
                )}
              </div>
            </div>

            {saving ? <div style={styles.saving}>Enregistrement…</div> : null}
          </div>

          {msg ? <div style={styles.alert}>{msg}</div> : null}

          <div style={styles.grid}>
            {agents.map((a) => {
              const checked = assignedSet.has(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => toggleAgent(a.id)}
                  style={{
                    ...styles.agentCard,
                    ...(checked ? styles.agentCardOn : null),
                  }}
                  disabled={!selectedUserId}
                  title={a.slug}
                >
                  <div style={styles.agentTop}>
                    <img src={a.avatar_url || "/images/logopc.png"} alt={a.name} style={styles.avatar} />
                    <div style={styles.agentMeta}>
                      <div style={styles.agentName}>{a.name}</div>
                      <div style={styles.agentDesc}>{a.description}</div>
                      <div style={styles.agentSlug}>{a.slug}</div>
                    </div>
                  </div>
                  <div style={styles.checkRow}>
                    <div style={styles.check}>{checked ? "Assigné" : "Non assigné"}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "#eef2ff",
    fontFamily: "Segoe UI, Arial, sans-serif",
  },
  topbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.28)",
    backdropFilter: "blur(10px)",
  },
  brand: { fontWeight: 900, letterSpacing: 0.2 },
  topRight: { display: "flex", gap: 10, alignItems: "center" },
  chip: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
    fontWeight: 900,
    fontSize: 12,
    maxWidth: 260,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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
  layout: {
    display: "grid",
    gridTemplateColumns: "360px 1fr",
    gap: 14,
    padding: 14,
  },
  panel: {
    borderRadius: 22,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.45)",
    backdropFilter: "blur(14px)",
    overflow: "hidden",
    minHeight: "calc(100vh - 90px)",
    display: "flex",
    flexDirection: "column",
  },
  panelHeader: {
    padding: 14,
    borderBottom: "1px solid rgba(255,255,255,.08)",
    background: "rgba(0,0,0,.18)",
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
  },
  panelTitle: { fontWeight: 900, fontSize: 13 },
  sub: { marginTop: 6, opacity: 0.8, fontWeight: 700, fontSize: 12, lineHeight: 1.4 },
  search: {
    width: 190,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.40)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 800,
    fontSize: 12,
  },
  list: { padding: 10, overflowY: "auto", display: "grid", gap: 10 },
  item: {
    textAlign: "left",
    width: "100%",
    padding: 12,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.28)",
    color: "#eef2ff",
    cursor: "pointer",
    display: "grid",
    gap: 6,
  },
  itemActive: {
    background: "linear-gradient(135deg, rgba(255,140,40,.14), rgba(80,120,255,.10))",
    border: "1px solid rgba(255,140,40,.18)",
  },
  itemTop: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" },
  itemEmail: { fontWeight: 900, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" },
  badge: {
    fontSize: 11,
    fontWeight: 900,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.06)",
  },
  itemId: { fontSize: 11, opacity: 0.7, fontWeight: 700 },
  grid: {
    padding: 14,
    overflowY: "auto",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 14,
  },
  agentCard: {
    textAlign: "left",
    width: "100%",
    padding: 14,
    borderRadius: 20,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.28)",
    color: "#eef2ff",
    cursor: "pointer",
    display: "grid",
    gap: 12,
  },
  agentCardOn: {
    border: "1px solid rgba(255,140,40,.25)",
    background: "linear-gradient(135deg, rgba(255,140,40,.14), rgba(80,120,255,.10))",
  },
  agentTop: { display: "flex", gap: 12, alignItems: "center" },
  avatar: { width: 56, height: 56, borderRadius: "50%", objectFit: "cover" },
  agentMeta: { display: "grid", gap: 3, minWidth: 0 },
  agentName: { fontWeight: 900, fontSize: 15 },
  agentDesc: { fontWeight: 800, fontSize: 12, opacity: 0.8 },
  agentSlug: { fontWeight: 900, fontSize: 11, opacity: 0.7 },
  checkRow: { display: "flex", justifyContent: "flex-end" },
  check: {
    fontWeight: 900,
    fontSize: 12,
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
  },
  alert: {
    margin: 12,
    padding: 12,
    borderRadius: 16,
    background: "rgba(255,140,40,.10)",
    border: "1px solid rgba(255,140,40,.18)",
    color: "#eef2ff",
    fontWeight: 900,
    fontSize: 13,
  },
  saving: { fontWeight: 900, fontSize: 12, opacity: 0.8 },
  card: {
    margin: "60px auto",
    maxWidth: 720,
    padding: 24,
    borderRadius: 22,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.45)",
    backdropFilter: "blur(14px)",
  },
  h1: { fontSize: 22, fontWeight: 900 },
  p: { marginTop: 10, opacity: 0.8, fontWeight: 800 },
};
