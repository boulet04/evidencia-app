// pages/admin/settings.js
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function AdminSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState("");

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  function goBack() {
    window.location.href = "/admin";
  }

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  async function loadValue() {
    setLoading(true);
    setMsg("");
    try {
      const token = await getAccessToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }

      const res = await fetch("/api/admin/get-base-prompt", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data?.error || `Erreur (${res.status})`);
        return;
      }

      setValue((data?.value || "").toString());
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    setMsg("");
    try {
      const token = await getAccessToken();
      if (!token) {
        window.location.href = "/login";
        return;
      }

      const res = await fetch("/api/admin/save-base-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ value }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data?.error || `Erreur (${res.status})`);
        return;
      }

      setMsg("Enregistré.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    loadValue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main style={styles.page}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.headerBtn} onClick={goBack} title="Retour admin">
            ← Retour
          </button>

          <img
            src="/images/logolong.png"
            alt="Evidenc'IA"
            style={styles.headerLogo}
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />

          <div style={styles.headerTitle}>Paramètres — Base prompt global</div>
        </div>

        <div style={styles.headerRight}>
          <button style={styles.headerBtnDanger} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </div>

      <div style={styles.wrap}>
        <div style={styles.box}>
          <div style={styles.boxTitle}>Base prompt global (appliqué à tous les agents)</div>

          <div style={styles.small}>
            Ce texte est préfixé automatiquement dans <b>/api/chat</b> avant le prompt agent et les instructions personnalisées.
          </div>

          <div style={{ height: 10 }} />

          {loading ? (
            <div style={styles.muted}>Chargement…</div>
          ) : (
            <>
              <textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                style={styles.textarea}
                placeholder="Colle ici le base prompt global…"
              />

              <div style={styles.actions}>
                <button style={styles.btnGhost} onClick={loadValue} disabled={saving}>
                  Recharger
                </button>
                <button style={styles.btnAssign} onClick={save} disabled={saving}>
                  {saving ? "Enregistrement…" : "Enregistrer"}
                </button>
              </div>

              {!!msg && <div style={styles.noteOk}>{msg}</div>}
            </>
          )}
        </div>
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
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "14px 16px 0",
    flexWrap: "wrap",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12, minWidth: 280 },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  headerLogo: { height: 26, width: "auto", opacity: 0.95, display: "block" },
  headerTitle: { fontWeight: 900, opacity: 0.9 },

  headerBtn: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.25)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  headerBtnDanger: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  wrap: { padding: 18, maxWidth: 1100, margin: "0 auto" },

  box: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
  },
  boxTitle: { fontWeight: 900, marginBottom: 10 },

  small: { fontSize: 12, opacity: 0.75, fontWeight: 800 },
  muted: { opacity: 0.75, fontWeight: 800, fontSize: 13 },

  textarea: {
    width: "100%",
    minHeight: 380,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    padding: 12,
    outline: "none",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 13,
    fontWeight: 700,
  },

  actions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 },

  btnAssign: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  btnGhost: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.20)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },

  noteOk: {
    marginTop: 12,
    padding: 10,
    borderRadius: 12,
    border: "1px solid rgba(80,120,255,.35)",
    background: "rgba(80,120,255,.10)",
    fontWeight: 900,
  },
};
