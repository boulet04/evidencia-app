import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Chat() {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");

  const [agent, setAgent] = useState(null); // { slug, name, description, avatar_url }
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const canSend = useMemo(() => input.trim().length > 0 && !sending, [input, sending]);

  useEffect(() => {
    let mounted = true;

    async function boot() {
      setErrorMsg("");

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        window.location.href = "/login";
        return;
      }
      if (!mounted) return;

      setEmail(session.user.email || "");

      // slug agent
      const url = new URL(window.location.href);
      const raw = url.searchParams.get("agent");
      const slug = (raw ? decodeURIComponent(raw) : "").trim().toLowerCase();

      if (!slug) {
        window.location.href = "/agents";
        return;
      }

      // Récup agent depuis Supabase (source de vérité)
      const { data: a, error } = await supabase
        .from("agents")
        .select("slug, name, description, avatar_url")
        .eq("slug", slug)
        .maybeSingle();

      if (!mounted) return;

      if (error || !a) {
        alert("Agent introuvable.");
        window.location.href = "/agents";
        return;
      }

      setAgent(a);

      // Message d'accueil propre (pas de doublon)
      setMessages([
        {
          role: "assistant",
          content: `Bonjour, je suis ${a.name}, ${a.description}. Comment puis-je vous aider ?`,
        },
      ]);

      setLoading(false);

      // logout => retour login
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, newSession) => {
        if (!newSession) window.location.href = "/login";
      });

      return () => subscription?.unsubscribe();
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

  async function sendMessage() {
    if (!agent || !canSend) return;

    const userText = input.trim();
    setInput("");
    setErrorMsg("");

    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setSending(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userText,
          agentSlug: agent.slug,
        }),
      });

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        throw new Error(data?.error || "Erreur API");
      }

      const reply = data?.reply || "Réponse vide.";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setErrorMsg("Erreur interne. Réessayez plus tard.");
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Erreur interne. Réessayez plus tard." },
      ]);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  if (loading || !agent) {
    return (
      <main style={styles.page}>
        <div style={styles.bg} aria-hidden="true">
          <div style={styles.bgLogo} />
          <div style={styles.bgVeils} />
        </div>
        <section style={styles.center}>
          <div style={styles.loadingCard}>
            <div style={{ fontWeight: 900, color: "#fff" }}>Chargement…</div>
            <div style={{ marginTop: 6, color: "rgba(255,255,255,.78)", fontWeight: 800, fontSize: 12 }}>
              Initialisation de l’agent…
            </div>
          </div>
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
        <div style={styles.topLeft}>
          <button style={styles.backBtn} onClick={() => (window.location.href = "/agents")}>
            ← Retour
          </button>

          <div style={styles.brandBlock}>
            <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.brandLogo} />
            <div style={styles.agentLine}>
              <span
