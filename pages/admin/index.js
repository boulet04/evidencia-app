import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function Admin() {
  const [loading, setLoading] = useState(true);

  const [me, setMe] = useState(null);

  // Clients + users
  const [clients, setClients] = useState([]); // [{id, name, ...}]
  const [clientUsers, setClientUsers] = useState([]); // [{client_id, user_id}]
  const [profiles, setProfiles] = useState([]); // [{user_id, email, role, ...}]

  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");

  // Agents + mapping
  const [agents, setAgents] = useState([]);
  const [userAgents, setUserAgents] = useState([]);

  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const isAdmin = useMemo(() => me?.role === "admin", [me]);

  function normalizeImgSrc(src) {
    const s = (src || "").trim();
    if (!s) return "";
    if (s.startsWith("http://") || s.startsWith("https://")) return s;
    if (s.startsWith("/")) return s;
    return "/" + s;
  }

  function clientLabel(c) {
    return (c?.name || c?.customer_name || c?.title || "").trim() || "Client";
  }

  const clientTree = useMemo(() => {
    // Structure : client -> users (profiles)
    const profByUserId = new Map();
    for (const p of profiles) profByUserId.set(p.user_id, p);

    const usersByClient = new Map();
    for (const cu of clientUsers) {
      if (!usersByClient.has(cu.client_id)) usersByClient.set(cu.client_id, []);
      const prof = profByUserId.get(cu.user_id);
      usersByClient.get(cu.client_id).push({
        user_id: cu.user_id,
        email: prof?.email || "",
        role: prof?.role || "user",
      });
    }

    // Tri users : admin en bas, sinon par email
    for (const [cid, arr] of usersByClient.entries()) {
      arr.sort((a, b) => {
        if (a.role === "admin" && b.role !== "admin") return 1;
        if (a.role !== "admin" && b.role === "admin") return -1;
        return (a.email || "").localeCompare(b.email || "");
      });
      usersByClient.set(cid, arr);
    }

    const result = (clients || []).map((c) => ({
      ...c,
      label: clientLabel(c),
      users: usersByClient.get(c.id) || [],
    }));

    // filtre recherche (sur client + email + user_id)
    const s = q.trim().toLowerCase();
    if (!s) return result;

    return result
      .map((c) => {
        const users = (c.users || []).filter((u) => {
          const email = (u.email || "").toLowerCase();
          const uid = (u.user_id || "").toLowerCase();
          return email.includes(s) || uid.includes(s);
        });
        const clientMatch = (c.label || "").toLowerCase().includes(s);
        if (!clientMatch && users.length === 0) return null;
        return { ...c, users: clientMatch ? c.users : users };
      })
      .filter(Boolean);
  }, [clients, clientUsers, profiles, q]);

  const selectedClient = useMemo(
    () => clients.find((c) => c.id === selectedClientId) || null,
    [clients, selectedClientId]
  );

  const selectedUser = useMemo(() => {
    const p = profiles.find((x) => x.user_id === selectedUserId) || null;
    const email = p?.email || "";
    const role = p?.role || "user";
    return selectedUserId ? { user_id: selectedUserId, email, role } : null;
  }, [profiles, selectedUserId]);

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
        .select("*")
        .eq("user_id", session.user.id)
        .maybeSingle();

      let myProfile = myProfile1;

      // si profil absent, tente de le créer
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
          .select("*")
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
        setMsg(
          myErr1
            ? `Lecture du profil impossible : ${myErr1.message}`
            : "Profil introuvable (table profiles)."
        );
        return;
      }

      const myProfileSafe = {
        ...myProfile,
        email: myProfile.email || session.user.email || null,
      };

      setMe(myProfileSafe);

      if (myProfileSafe.role !== "admin") {
        setLoading(false);
        setMsg("Accès refusé : vous n’êtes pas admin.");
        return;
      }

      // Charger clients
      const { data: c, error: cErr } = await supabase
        .from("clients")
        .select("*")
        .order("name", { ascending: true });

      // Charger client_users
      const { data: cu, error: cuErr } = await supabase
        .from("client_users")
        .select("client_id, user_id");

      // Charger profiles (pour email/role)
      const { data: p, error: pErr } = await supabase
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

      const clientsSafe = cErr ? [] : c || [];
      const clientUsersSafe = cuErr ? [] : cu || [];
      const profilesSafe = pErr ? [] : p || [];

      setClients(clientsSafe);
      setClientUsers(clientUsersSafe);
      setProfiles(profilesSafe);

      setAgents(aErr ? [] : a || []);
      setUserAgents(uaErr ? [] : ua || []);

      // Sélection auto : 1er client, puis 1er user du client
      const firstClientId = clientsSafe[0]?.id || "";
      setSelectedClientId(firstClientId);

      const firstUserForClient =
        clientUsersSafe.find((x) => x.client_id === firstClientId)?.user_id || "";
      setSelectedUserId(firstUserForClient);

      setLoading(false);
    }

    boot();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    // quand on change de client : sélectionner automatiquement le premier user du client
    if (!selectedClientId) return;
    const firstUserForClient =
      clientUsers.find((x) => x.client_id === selectedClientId)?.user_id || "";
    setSelectedUserId(firstUserForClient);
  }, [selectedClientId]); // volontaire : pas clientUsers ici (sinon reselect trop souvent)

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
        const { error } = await supabase
          .from("user_agents")
          .delete()
          .eq("user_id", selectedUserId)
          .eq("agent_id", agentId);

        if (error) throw error;

        setUserAgents((prev) =>
          prev.filter(
            (r) => !(r.user_id === selectedUserId && r.agent_id === agentId)
          )
        );
      } else {
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
          <button
            style={styles.btnGhost}
            onClick={() => (window.location.href = "/agents")}
          >
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
          <button style={styles.btnGhost} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </header>

      <section style={styles.layout}>
        {/* CLIENTS + USERS */}
        <aside style={styles.panel}>
          <div style={styles.panelHeader}>
            <div style={styles.panelTitle}>Clients</div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher client / email / id…"
              style={styles.search}
            />
          </div>

          <div style={styles.list}>
            {clientTree.map((c) => {
              const activeClient = c.id === selectedClientId;
              return (
                <div
                  key={c.id}
                  style={{
                    ...styles.clientBlock,
                    ...(activeClient ? styles.clientBlockActive : null),
                  }}
                >
                  <button
                    onClick={() => setSelectedClientId(c.id)}
                    style={styles.clientHeaderBtn}
                    title={c.label}
                  >
                    <div style={styles.clientName}>{c.label}</div>
                    <div style={styles.clientCount}>
                      {c.users?.length || 0} user(s)
                    </div>
                  </button>

                  <div style={styles.clientUsers}>
                    {(c.users || []).map((u) => {
                      const activeUser = u.user_id === selectedUserId;
                      return (
                        <button
                          key={u.user_id}
                          onClick={() => {
                            setSelectedClientId(c.id);
                            setSelectedUserId(u.user_id);
                          }}
                          style={{
                            ...styles.userRow,
                            ...(activeUser ? styles.userRowActive : null),
                          }}
                          title={u.email || u.user_id}
                        >
                          <div style={styles.userEmail}>
                            {u.email || "(email non renseigné)"}
                          </div>
                          <div style={styles.userBadge}>{u.role}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
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
                <div>
                  <b>Client :</b>{" "}
                  {selectedClient ? clientLabel(selectedClient) : "-"}
                </div>
                <div>
                  <b>Utilisateur :</b>{" "}
                  {selectedUser
                    ? selectedUser.email || selectedUser.user_id
                    : "-"}
                </div>
                <div>
                  <b>user_id :</b> {selectedUser ? selectedUser.user_id : "-"}
                </div>
              </div>
            </div>

            {saving ? <div style={styles.saving}>Enregistrement…</div> : null}
          </div>

          {msg ? <div style={styles.alert}>{msg}</div> : null}

          <div style={styles.grid}>
            {agents.map((a) => {
              const checked = assignedSet.has(a.id);
              const src = normalizeImgSrc(a.avatar_url) || "/images/logopc.png";

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
                  <div style={styles.agentTopCenter}>
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
    gridTemplateColumns: "420px 1fr",
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
    width: 210,
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

  clientBlock: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    overflow: "hidden",
  },
  clientBlockActive: {
    border: "1px solid rgba(255,140,40,.18)",
    background: "linear-gradient(135deg, rgba(255,140,40,.10), rgba(80,120,255,.08))",
  },
  clientHeaderBtn: {
    width: "100%",
    textAlign: "left",
    padding: 12,
    border: "none",
    cursor: "pointer",
    background: "rgba(0,0,0,.20)",
    color: "#eef2ff",
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center",
  },
  clientName: {
    fontWeight: 900,
    fontSize: 13,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  clientCount: {
    fontWeight: 900,
    fontSize: 11,
    opacity: 0.7,
    whiteSpace: "nowrap",
  },

  clientUsers: {
    padding: 10,
    display: "grid",
    gap: 8,
    background: "rgba(0,0,0,.12)",
  },
  userRow: {
    width: "100%",
    textAlign: "left",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    color: "#eef2ff",
    cursor: "pointer",
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center",
  },
  userRowActive: {
    border: "1px solid rgba(255,140,40,.20)",
    background: "rgba(255,140,40,.08)",
  },
  userEmail: {
    fontWeight: 900,
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  userBadge: {
    fontSize: 11,
    fontWeight: 900,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.06)",
    whiteSpace: "nowrap",
  },

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
  agentTopCenter: { display: "flex", justifyContent: "center", alignItems: "center", paddingTop: 4 },
  avatar: { width: 74, height: 74, borderRadius: "50%", objectFit: "cover" },
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
