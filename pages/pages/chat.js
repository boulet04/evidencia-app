import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function Chat() {
  const [email, setEmail] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data?.user) {
        window.location.href = "/login";
        return;
      }
      setEmail(data.user.email || "");
    })();
  }, []);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <main style={{ padding: 24, fontFamily: "Segoe UI, Arial, sans-serif" }}>
      <h1>Chat – Evidenc’IA</h1>
      <p>Connecté en tant que : <strong>{email}</strong></p>

      <p>Cette page est provisoire. Prochaine étape : l’interface conversation + contrôle licence.</p>

      <button onClick={logout} style={{ padding: "10px 14px", borderRadius: 999, fontWeight: 900 }}>
        Se déconnecter
      </button>
    </main>
  );
}
