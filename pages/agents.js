import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Chat() {
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [email, setEmail] = useState("");

  useEffect(() => {
    let mounted = true;

    async function boot() {
      // session
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = "/login";
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const agentSlug = params.get("agent");

      // 🚨 SI PAS D’AGENT → RETOUR À LA LISTE
      if (!agentSlug) {
        window.location.href = "/agents";
        return;
      }

      setEmail(session.user.email || "");

      // charger l’agent
      const { data: agentData } = await supabase
        .from("agents")
        .select("name, description")
        .eq("slug", agentSlug)
        .single();

      if (!agentData) {
        window.location.href = "/agents";
        return;
      }

      if (!mounted) return;

      setAgent(agentData);

      // message initial CORRECT
      setMessages([
        {
          role: "assistant",
          content: `Bonjour, je suis ${agentData.name}. ${agentData.description}`,
        },
      ]);

      setLoading(false);
    }

    boot();
    return () => { mounted = false; };
  }, []);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  async function sendMessage() {
    if (!input.trim()) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    setMessages((m) => [...m, { role: "user", content: text }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "Erreur technique. Réessayez." },
      ]);
    } finally {
      setSending(false);
    }
  }

  if (loading) return null;

  return (
    <main style={styles.page}>
      <header style={styles.topbar}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img src="/images/logolong.png" style={styles.brandLogo} />

          {/* ✅ BOUTON RETOUR → LISTE DES AGENTS */}
          <button
            style={styles.backBtn}
            onClick={() => (window.location.href = "/agents")}
          >
            ← Retour aux agents
          </button>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <span style={styles.userChip}>{email}</span>
          <button onClick={logout} style={styles.btnGhost}>
            Déconnexion
          </button>
        </div>
      </header>

      {/* CHAT (ton style existant conservé) */}
      <section style={styles.shell}>
        {/* messages */}
        {messages.map((m, i) => (
          <div key={i}>
            <strong>{m.role === "user" ? "Vous" : agent.name}</strong>
            <div>{m.content}</div>
          </div>
        ))}

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button onClick={sendMessage} disabled={sending}>
          Envoyer
        </button>
      </section>
    </main>
  );
}

/* styles existants conservés */
const styles = {
  page: { minHeight: "100vh", background: "#05060a", color: "#fff" },
  topbar: { display: "flex", justifyContent: "space-between", padding: 16 },
  brandLogo: { height: 22 },
  backBtn: {
    background: "transparent",
    border: "none",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
  },
  btnGhost: { background: "transparent", color: "#fff" },
  userChip: { fontSize: 12 },
  shell: { padding: 20 },
};
