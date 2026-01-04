import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);

  // Data
  const [clients, setClients] = useState([]); // public.clients
  const [clientUsers, setClientUsers] = useState([]); // public.client_users
  const [profiles, setProfiles] = useState([]); // public.profiles
  const [agents, setAgents] = useState([]); // public.agents
  const [userAgents, setUserAgents] = useState([]); // public.user_agents

  // UI state
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const isAdmin = useMemo(() => me?.role === "admin", [me]);

  function clientLabel(c) {
    // On supporte plusieurs noms de colonnes possibles sans casser
    const v =
      (c?.name || c?.customer_name || c?.company_name || c?.title || "").trim();
    return v || "Client";
  }

  function safeStr(v) {
    return (v || "").toString();
  }

  function normalizeImgSrc(src) {
    const s = safeStr(src).trim();
    if (!s) return "";
    if (s.startsWith("http://") || s.startsWith("https://")) return s;
    if (s.startsWith("/")) return s;
    return "/" + s;
  }

  // Indexes for fast lookups
  const profileByUserId = useMemo(() => {
    const m = new Map();
    for (const p of profiles) m.set(p.user_id, p);
    return m;
  }, [profiles]);

  const clientById = useMemo(() => {
    const m = new Map();
    for (const c of clients) m.set(c.id, c);
    return m;
  }, [clients]);

  // Build: Client -> Users (profiles)
  const clientTree = useMemo(() => {
    const usersByClient = new Map();

    for (const cu of clientUsers) {
      if (!usersByClient.has(cu.client_id)) usersByClient.set(cu.client_id, []);
      const p = profileByUserId.get(cu.user_id);
      usersByClient.get(cu.client_id).push({
        user_id: cu.user_id,
        email: safeStr(p?.email),
        role: safeStr(p?.role) || "user",
      });
    }

    // Build list from clients table
    let list = (clients || []).map((c) => ({
      id: c.id,
      raw: c,
      label: clientLabel(c),
      users: usersByClient.get(c.id) || [],
    }));

    // Tri : par label client
    list.sort((a, b) => a.label.localeCompare(b.label, "fr"));

    // Tri users dans chaque client : par email, admin en dernier
    for (const item of list) {
      item.users.sort((a, b) => {
        if (a.role === "admin" && b.role !== "admin") return 1;
        if (a.role !== "admin" && b.role === "admin") return -1;
        return safeStr(a.email).localeCompare(safeStr(b.email), "fr");
      });
    }

    // Filtre recherche (client label + email + user_id)
    const s = q.trim().toLowerCase();
    if (!s) return list;

    return list
      .map((c) => {
        const labelMatch = safeStr(c.label).toLowerCase().includes(s);
        const usersFiltered = (c.users || []).filter((u) => {
          const email = safeStr(u.email).toLowerCase();
          const uid = safeStr(u.user_id).toLowerCase();
          return email.includes(s) || uid.includes(s);
        });
        if (!labelMatch && usersFiltered.length === 0) return null;
        return { ...c, users: labelMatch ? c.users : usersFiltered };
      })
      .filter(Boolean);
  }, [clients, clientUsers, profileByUserId, q]);

  const selectedClient = useMemo(() => {
    return selectedClientId ? clientById.get(selectedClientId) || null : null;
  }, [clientById, selectedClientId]);

  const selectedUser = useMemo(() => {
    if (!selectedUserId) return null;
    const p = profileByUserId.get(selectedUserId);
    return {
      user_id: selectedUserId,
      email: safeStr(p?.email),
      role: safeStr(p?.role) || "user",
    };
  }, [profileByUserId, selectedUserId]);

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
      setLoading(true);

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        window.location.href = "/login";
        return;
      }

      // 1) Lire profil connecté
      const { data: myP1, error: myE1 } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", session.user.id)
        .maybeSingle();

      let myProfile = myP1;

      // 1bis) si absent, créer profil (comme avant)
      if (!myE1 && !myProfile) {
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

        const { data: myP2, error: myE2 } = await supabase
          .from("profiles")
          .select("*")
          .eq("user_id", session.user.id)
          .maybeSingle();

        if (myE2) {
          if (!mounted) return;
          setLoading(false);
          setMsg(`Lecture du profil impossible : ${myE2.message}`);
          return;
        }

        myProfile = myP2 || null;
      }

      if (!mounted) return;

      if (myE1 || !myProfile) {
        setLoading(false);
        setMsg(myE1 ? `Lecture du profil impossible : ${myE1.message}` : "Profil introuvable (table profiles).");
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

      // 2) Charger données (SANS order('name') sur clients pour éviter l'erreur de colonne)
      const [cRes, cuRes, pRes, aRes, uaRes] = await Promise.all([
        supabase.from("clients").select("*"),
        supabase.from("client_users").select("client_id, user_id"),
        supabase.from("profiles").select("user_id, email, role"),
        supabase
          .from("agents")
          .select("id, slug, name, description, avatar_url"),
        supabase
          .from("user_agents")
          .select("user_id, agent_id, created_at")
          .order("created_at", { ascending: false }),
      ]);

      if (!mounted) return;

      const cErr = cRes.error;
      const cuErr = cuRes.error;
      const pErr = pRes.error;
      const aErr = aRes.error;
      const uaErr = uaRes.error;

      if (cErr || cuErr || pErr || aErr || uaErr) {
        // On affiche une erreur claire, mais on garde ce qu'on a
        const parts = [];
        if (cErr) parts.push(`clients: ${cErr.message}`);
        if (cuErr) parts.push(`client_users: ${cuErr.message}`);
        if (pErr) parts.push(`profiles: ${pErr.message}`);
        if (aErr) parts.push(`agents: ${aErr.message}`);
        if (uaErr) parts.push(`user_agents: ${uaErr.message}`);
        setMsg("Chargement partiel : " + parts.join(" | "));
      }

      const clientsSafe = cRes.data || [];
      const clientUsersSafe = cuRes.data || [];
      const profilesSafe = pRes.data || [];
      const agentsSafe = aRes.data || [];
      const userAgentsSafe = uaRes.data || [];

      setClients(clientsSafe);
      setClientUsers(clientUsersSafe);
      setProfiles(profilesSafe);
      setAgents(agentsSafe);
      setUserAgents(userAgentsSafe);

      // 3) Sélections par défaut : 1er client qui a au moins 1 user, sinon 1er client, sinon rien
      let defaultClientId = "";
      let defaultUserId = "";

      const firstWithUser = clientsSafe.find((c) =>
        clientUsersSafe.some((x) => x.client_id === c.id)
      );
      defaultClientId = firstWithUser?.id || clientsSafe[0]?.id || "";

      if (defaultClientId) {
        defaultUserId =
          clientUsersSafe.find((x) => x.client_id === defaultClientId)?.user_id ||
          "";
      }

      setSelectedClientId(defaultClientId);
      setSelectedUserId(defaultUserId);

      setLoading(false);
    }

    boot();
    return () => {
      mounted = false;
    };
  }, []);

  // Quand on change de client => sélectionner le premier user du client
  useEffect(() => {
    if (!selectedClientId) return;
    const firstUserId =
      clientUsers.find((x) => x.client_id === selectedClientId)?.user_id || "";
    setSelectedUserId(firstUserId);
  }, [selectedClientId, clientUsers]);

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
            {clientTree.length === 0 ? (
              <div style={styles.emptyBox}>
                Aucun client / utilisateur à afficher.
                <div style={{ marginTop: 8, opacity: 0.8 }}>
                  Vérifie que les tables <b>clients</b> et <b>client_users</b> ont
                  des données.
                </div>
              </div>
            ) : (
              clientTree.map((c) => {
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
                        {(c.users || []).length} user(s)
                      </div>
                    </button>

                    <div style={styles.clientUsers}>
                      {(c.users || []).length === 0 ? (
                        <div style={styles.miniEmpty}>Aucun utilisateur rattaché.</div>
                      ) : (
                        c.users.map((u) => {
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
                        })
                      )}
                    </div>
                  </div>
                );
              })
            )}
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

              // IMPORTANT: on garde la logique qui marche (normalisation + fallback)
              const src =
                normalizeImgSrc(a.avatar_url) || `/images/${a.slug}.png`;

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
                    <div style={styles.check}>
                      {checked ? "Assigné" : "Non assigné"}
                    </div>
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
  sub: {
    marginTop: 6,
    opacity: 0.8,
    fontWeight: 700,
    fontSize: 12,
    lineHeight: 1.4,
  },
  search: {
    width: 230,
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
  emptyBox: {
    padding: 14,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    fontWeight: 800,
    fontSize: 12,
    opacity: 0.85,
    lineHeight: 1.45,
  },
  clientBlock: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    overflow: "hidden",
  },
  clientBlockActive: {
    border: "1px solid rgba(255,140,40,.18)",
    background:
      "linear-gradient(135deg, rgba(255,140,40,.10), rgba(80,120,255,.08))",
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
  miniEmpty: {
    padding: 10,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.18)",
    fontWeight: 800,
    fontSize: 12,
    opacity: 0.8,
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
    background:
      "linear-gradient(135deg, rgba(255,140,40,.14), rgba(80,120,255,.10))",
  },
  agentTop: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 6,
  },
  avatar: {
    width: 74,
    height: 74,
    borderRadius: "50%",
    objectFit: "cover",
    display: "block",
  },
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
