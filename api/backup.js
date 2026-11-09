// Vercel Serverless Function : sauvegarde automatique (chaque nuit) et accès aux sauvegardes (Super Administrateur).
import { admin, requireOwner } from './_lib.js';
import { run, list, link, isCron } from './_backup.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sb = admin();
    if (req.method === 'GET') {
      if (!isCron(req)) return res.status(401).json({ error: 'Non autorisé' });
      return res.status(200).json(await run(sb));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    const user = await requireOwner(sb, req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (body.action === 'list') return res.status(200).json({ items: await list(sb) });
    if (body.action === 'link') return res.status(200).json(await link(sb, body.name));
    if (body.action === 'run') return res.status(200).json(await run(sb, { by: user.email || 'Super Administrateur' }));
    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Erreur serveur' });
  }
}
