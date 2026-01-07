import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabaseClient';
import Layout from '../../components/Layout';

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
      // Récupération des clients (profiles)
      const { data: clientsData, error: clientsError } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (clientsError) throw clientsError;

      // Récupération des conversations avec jointure sur profiles
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

  return (
    <Layout>
      <div className="p-8 bg-[#0a0a0a] min-h-screen text-white font-sans">
        <h1 className="text-3xl font-bold text-center text-[#ff8c00] mb-12">
          Console Admin - Evidenc’IA
        </h1>

        <div className="max-w-6xl mx-auto space-y-12">
          {/* Section Gestion des Clients */}
          <section>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold border-l-4 border-[#ff8c00] pl-4">
                Gestion des Clients (Utilisateurs)
              </h2>
            </div>
            <div className="bg-[#1a1a1a] rounded-xl overflow-hidden shadow-2xl border border-gray-800">
              <table className="w-full text-left">
                <thead className="bg-[#252525] text-gray-400 uppercase text-xs">
                  <tr>
                    <th className="px-6 py-4">Email</th>
                    <th className="px-6 py-4">Date Inscription</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {clients.map((client) => (
                    <tr key={client.id} className="hover:bg-[#222] transition-colors">
                      <td className="px-6 py-4">{client.email}</td>
                      <td className="px-6 py-4">{new Date(client.created_at).toLocaleDateString()}</td>
                      <td className="px-6 py-4 text-right text-[#ff8c00] cursor-pointer hover:underline">Gérer</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Section Gestion des Conversations */}
          <section>
            <h2 className="text-xl font-semibold border-l-4 border-[#ff8c00] pl-4 mb-6">
              Gestion des Conversations
            </h2>
            <div className="bg-[#1a1a1a] rounded-xl overflow-hidden shadow-2xl border border-gray-800">
              <table className="w-full text-left">
                <thead className="bg-[#252525] text-gray-400 uppercase text-xs">
                  <tr>
                    <th className="px-6 py-4">Titre</th>
                    <th className="px-6 py-4">Agent</th>
                    <th className="px-6 py-4">Utilisateur</th>
                    <th className="px-6 py-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {conversations.map((conv) => (
                    <tr key={conv.id} className="hover:bg-[#222] transition-colors">
                      <td className="px-6 py-4">{conv.title || 'Sans titre'}</td>
                      <td className="px-6 py-4">{conv.agent_slug}</td>
                      <td className="px-6 py-4">{conv.profiles?.email}</td>
                      <td className="px-6 py-4 text-right text-[#ff8c00] cursor-pointer hover:underline">Voir</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </Layout>
  );
}
