// Vercel Serverless Function : gestion des comptes utilisateurs (Super Administrateur uniquement).
// La logique est dans _lib.js ; la clé « service_role » de Supabase ne quitte JAMAIS le serveur.
import { admin, requireOwner, handle } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const sb = admin();
    const caller = await requireOwner(sb, req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    res.status(200).json(await handle(sb, body, caller));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Erreur serveur' });
  }
}
