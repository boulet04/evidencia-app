import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabaseClient';

export default function AdminIndex() {
  const [clients, setClients] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      setLoading(true);
      const { data: clientsData, error: clientsError } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (clientsError) throw clientsError;

      const { data: convsData, error: convsError } = await supabase
        .from('conversations')
        .select(`
          *,
          profiles (
            email
          )
        `)
        .order('updated_at', { ascending: false });

      if (convsError) throw convsError;

      setClients(clientsData || []);
      setConversations(convsData || []);
    } catch (error) {
      console.error('Erreur lors du chargement des données:', error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="bg-[#0a0a0a] min-h-screen text-white p-8">Chargement...</div>;

  return (
    <div className="p-8 bg-[#0a0a0a] min-h-screen text-white font-sans">
      <h1 className="text-3xl font-bold text-center text-[#ff8c00] mb-12">
        Console Admin - Evidenc’IA
      </h1>

      <div className="max-w-6xl mx-auto space-y-12">
        <section>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-semibold border-l-4 border-[#ff8c00] pl-4">
              Gestion des Clients (Utilisateurs)
            </h2>
          </div>
          <div className="bg-[#1a1a1a] rounded-xl overflow-hidden shadow-2xl border border-gray-800">
            <table className="w-full text-left">
              <thead className="bg-[#252525] text-gray-400 uppercase text-xs">
