import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function AdminConsole() {
  const [profiles, setProfiles] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    setLoading(true);
    // Récupération des profils (clients)
    const { data: p } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
    // Récupération des conversations avec l'email du profil lié
    const { data: c } = await supabase.from("conversations").select("*, profiles(email)").order("updated_at", { ascending: false });
    
    setProfiles(p || []);
    setConversations(c || []);
    setLoading(false);
  }

  // Action : Supprimer une conversation
  async function deleteConversation(id) {
    if (!confirm("Supprimer cette conversation ?")) return;
    const { error } = await supabase.from("conversations").delete().eq("id", id);
    if (error) alert(error.message); else fetchData();
  }

  // Action : Supprimer un profil client
  async function deleteClient(id) {
    if (!confirm("Supprimer ce profil client ?")) return;
    const { error } = await supabase.from("profiles").delete().eq("id", id);
    if (error) alert(error.message); else fetchData();
  }

  // Action : Supprimer l'utilisateur du système d'authentification (via API)
  async function deleteUserAuth(userId) {
    if (!confirm("ATTENTION : Supprimer définitivement l'accès de cet utilisateur ?")) return;
    try {
      const resp = await fetch("/api/admin/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (resp.ok) {
        alert("Accès utilisateur supprimé.");
        fetchData();
      } else {
        alert("Erreur lors de la suppression de l'accès.");
      }
    } catch (err) {
      alert("Erreur réseau.");
    }
  }

  if (loading) return <div style={styles.loading}>Chargement de la console...</div>;

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Console Admin - Evidenc’IA</h1>

      <section style={styles.section}>
        <h2 style={styles.secTitle}>Gestion des Clients (Utilisateurs)</h2>
        <div style={styles.tableWrapper}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Email</th>
                <th style={styles.th}>Date Inscription</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.id} style={styles.tr}>
                  <td style={styles.td}>{p.email}</td>
                  <td style={styles.td}>{new Date(p.created_at).toLocaleDateString()}</td>
                  <td style={styles.td}>
                    <button onClick={() => deleteClient(p.id)} style={styles.btnDel}>Suppr Profil</button>
                    <button onClick={() => deleteUserAuth(p.id)} style={styles.btnDelDark}>Suppr Auth</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.secTitle}>Gestion des Conversations</h2>
        <div style={styles.tableWrapper}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Titre</th>
                <th style={styles.th}>Agent</th>
                <th style={styles.th}>Utilisateur</th>
                <th style={styles.th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map(c => (
                <tr key={c.id} style={styles.tr}>
                  <td style={styles.td}>{c.title}</td>
                  <td style={styles.td}>{c.agent_slug}</td>
                  <td style={styles.td}>{c.profiles?.email || "Inconnu"}</td>
                  <td style={styles.td}>
                    <button onClick={() => deleteConversation(c.id)} style={styles.btnDel}>Supprimer</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const styles = {
  container: { padding: "40px 20px", background: "#05060a", minHeight: "100vh", color: "#fff", fontFamily: "'Segoe UI', sans-serif" },
  title: { fontSize: 28, marginBottom: 40, color: "#ff8c28", fontWeight: 900, textAlign: 'center' },
  section: { marginBottom: 50, maxWidth: 1000, margin: '0 auto 40px auto' },
  secTitle: { fontSize: 18, marginBottom: 20, borderLeft: '4px solid #ff8c28', paddingLeft: 15 },
  tableWrapper: { background: "rgba(255,255,255,0.03)", borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.05)' },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { textAlign: 'left', padding: '15px 20px', background: 'rgba(255,255,255,0.05)', color: '#ff8c28', fontWeight: 900 },
  td: { padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)' },
  loading: { color: "#fff", textAlign: "center", marginTop: 100 },
  btnDel: { background: "#ff4d4d", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer", marginRight: 8, fontWeight: 600 },
  btnDelDark: { background: "#333", color: "#bbb", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontWeight: 600 }
};
