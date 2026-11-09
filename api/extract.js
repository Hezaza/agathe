// Vercel Serverless Function : lecture automatique d'un document pour pré-remplir la fiche d'un dossier.
// La clé API Anthropic reste sur le serveur ; le document n'est pas conservé.
import { admin } from './_lib.js';
import { extract } from './_extract.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "La lecture automatique n'est pas encore activée (clé ANTHROPIC_API_KEY absente dans Vercel)." });
    const sb = admin();
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const { data: u, error } = await sb.auth.getUser(token);
    if (error || !u || !u.user) return res.status(401).json({ error: 'Session expirée : reconnectez-vous' });
    const { data: p } = await sb.from('profiles').select('id,email,nom,role,perms,actif').eq('id', u.user.id).maybeSingle();
    if (!p || !p.actif) return res.status(403).json({ error: 'Compte inactif' });
    const own = p.role === 'owner', perms = p.perms || {};
    if (!own && perms.edit !== true && perms.create !== true) return res.status(403).json({ error: 'Lecture de documents réservée aux comptes autorisés à créer ou modifier des dossiers' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const out = await extract({ body, apiKey, model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', fetchImpl: fetch });
    try {
      const t = new Date().toISOString();
      await sb.from('docs').insert({ parent: 'audit', id: t.replace(/\D/g, '') + Math.random().toString(36).slice(2, 6), data: { t, u: p.nom || p.email, uid: p.id, cat: own ? 'SA' : 'U', a: 'lecture automatique de document', dos: String(body.dossier || '').slice(0, 30), document: out.type_document, champs: Object.keys(out.champs).length } });
    } catch (e) { /* journal facultatif */ }
    res.status(200).json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Erreur serveur' });
  }
}
