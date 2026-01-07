import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);

  const [clients, setClients] = useState([]);
  const [clientUsers, setClientUsers] = useState([]);
  const [profiles, setProfiles] = useState([]);

  const [selectedClientId, setSelectedClientId] = useState("");
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function refreshAll({ keepSelection = true } = {}) {
    setLoading(true);
    setMsg("");

    const prevClientId = selectedClientId;

    const [cRes, cuRes, pRes, meRes] = await Promise.all([
      supabase.from("clients").select("*").order("created_at", { ascending: false }),
      supabase.from("client_users").select("client_id,user_id"),
      supabase.from("profiles").select("user_id,email,role"),
      supabase.auth.getUser(),
    ]);

    if (meRes?.data?.user) setMe(meRes.data.user);

    const errors = [cRes.error, cuRes.error, pRes.error].filter(Boolean);
    if (errors.length) {
      setMsg(errors.map((e) => e.message).join(" | "));
    }

    setClients(cRes.data || []);
    setClientUsers(cuRes.data || []);
    setProfiles(pRes.data || []);

    // garder sélection si possible
    if (keepSelection && prevClientId) {
      const stillExists = (cRes.data || []).some((c) => c.id === prevClientId);
      setSelectedClientId(stillExists ? prevClientId : "");
    }

    setLoading(false);
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredClients = useMemo(() => {
    const qq = (q || "").trim().toLowerCase();
    if (!qq) return clients;
    return clients.filter((c) => (c?.name || "").toLowerCase().includes(qq));
  }, [clients, q]);

  const selectedClient = useMemo(() => {
    return clients.find((c) => c.id === selectedClientId) || null;
  }, [clients, selectedClientId]);

  const usersForSelectedClient = useMemo(() => {
    if (!selectedClientId) return [];
    const links = clientUsers.filter((x) => x.client_id === selectedClientId);
    return links.map((l) => {
      const p = profiles.find((pp) => pp.user_id === l.user_id);
      return {
        user_id: l.user_id,
        email: p?.email || "(email non renseigné)",
        role: p?.role || "",
      };
    });
  }, [selectedClientId, clientUsers, profiles]);

  async function deleteClient(clientId, clientName) {
    const ok = window.confirm(
      `Supprimer le client "${clientName}" ?\n\nCela supprime le client et la liaison client_users.\nLes comptes utilisateurs ne seront PAS supprimés.`
    );
    if (!ok) return;

    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/delete-client", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ clientId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(`Erreur (${res.status}) : ${data?.error || "?"}`);
      return;
    }

    // Nettoyage UI
    if (selectedClientId === clientId) setSelectedClientId("");
    setQ("");
    await refreshAll({ keepSelection: false });
  }

  async function removeClientUser(clientId, userId) {
    const ok = window.confirm(
      `Retirer cet utilisateur du client ?\n\nCela supprime uniquement la liaison client_users.\nLe compte utilisateur n'est pas supprimé.`
    );
    if (!ok) return;

    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/remove-client-user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ clientId, userId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(`Erreur (${res.status}) : ${data?.error || "?"}`);
      return;
    }

    await refreshAll({ keepSelection: true });
  }

  return (
    <main style={styles.page}>
      <div style={styles.header}>
        <div style={styles.brand}>Evidenc’IA</div>
        <div style={styles.title}>Console administrateur</div>
      </div>

      <div style={styles.wrap}>
        <aside style={styles.left}>
          <div style={styles.box}>
            <div style={styles.boxTitle}>Clients</div>

            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher client / email"
              style={styles.search}
            />

            {loading ? (
              <div style={styles.muted}>Chargement…</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {filteredClients.map((c) => {
                  const count = clientUsers.filter((x) => x.client_id === c.id).length;
                  const active = c.id === selectedClientId;
                  return (
                    <div
                      key={c.id}
                      style={{ ...styles.clientCard, ...(active ? styles.clientCardActive : {}) }}
                      onClick={() => setSelectedClientId(c.id)}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div>
                          <div style={styles.clientName}>{c.name}</div>
                          <div style={styles.small}>{count} user(s)</div>
                        </div>

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteClient(c.id, c.name);
                          }}
                          style={styles.dangerBtn}
                          title="Supprimer le client"
                        >
                          Supprimer
                        </button>
                      </div>
                    </div>
                  );
                })}
                {!filteredClients.length && <div style={styles.muted}>Aucun client.</div>}
              </div>
            )}
          </div>
        </aside>

        <section style={styles.right}>
          <div style={styles.box}>
            <div style={styles.boxTitle}>
              {selectedClient ? `Client : ${selectedClient.name}` : "Sélectionnez un client"}
            </div>

            {selectedClient && (
              <>
                <div style={styles.small}>
                  ID : <span style={{ fontFamily: "monospace" }}>{selectedClient.id}</span>
                </div>

                <div style={{ height: 14 }} />

                <div style={styles.subTitle}>Utilisateurs</div>

                <div style={{ display: "grid", gap: 10 }}>
                  {usersForSelectedClient.map((u) => (
                    <div key={u.user_id} style={styles.userRow}>
                      <div>
                        <div style={styles.userEmail}>{u.email}</div>
                        <div style={styles.small}>
                          user_id : <span style={{ fontFamily: "monospace" }}>{u.user_id}</span>
                        </div>
                      </div>

                      <button
                        onClick={() => removeClientUser(selectedClient.id, u.user_id)}
                        style={styles.xBtn}
                        title="Retirer l’utilisateur du client"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {!usersForSelectedClient.length && (
                    <div style={styles.muted}>Aucun utilisateur lié.</div>
                  )}
                </div>
              </>
            )}

            {!!msg && <div style={styles.alert}>{msg}</div>}
          </div>
        </section>
      </div>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "rgba(238,242,255,.92)",
    fontFamily: '"Segoe UI", Arial, sans-serif',
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: 12,
    padding: "18px 18px 0",
  },
  brand: { fontWeight: 900, fontSize: 18 },
  title: { opacity: 0.85, fontWeight: 800 },
  wrap: {
    display: "grid",
    gridTemplateColumns: "360px 1fr",
    gap: 16,
    padding: 18,
  },
  left: {},
  right: {},
  box: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
  },
  boxTitle: { fontWeight: 900, marginBottom: 10 },
  subTitle: { fontWeight: 900, marginBottom: 10 },
  search: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    outline: "none",
    marginBottom: 12,
    fontWeight: 800,
  },
  clientCard: {
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.03)",
    cursor: "pointer",
  },
  clientCardActive: { borderColor: "rgba(255,140,40,.35)", background: "rgba(255,140,40,.08)" },
  clientName: { fontWeight: 900 },
  small: { fontSize: 12, opacity: 0.75, fontWeight: 800 },
  muted: { opacity: 0.75, fontWeight: 800, fontSize: 13 },
  dangerBtn: {
    borderRadius: 999,
    padding: "8px 12px",
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  userRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.03)",
  },
  userEmail: { fontWeight: 900 },
  xBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  alert: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    fontWeight: 900,
  },
};
