// Vercel Serverless Function : assistant AGATHE (Claude). La clé API reste sur le serveur.
import { admin } from './_lib.js';
import { chat, rights } from './_chat.js';
import { aiConfig, NO_KEY, withFallback } from './_llm.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const cfg = aiConfig();
    if (!cfg) return res.status(503).json({ error: NO_KEY });
    const sb = admin();
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const { data: u, error } = await sb.auth.getUser(token);
    if (error || !u || !u.user) return res.status(401).json({ error: 'Session expirée : reconnectez-vous' });
    const { data: profile } = await sb.from('profiles').select('id,email,nom,role,perms,actif').eq('id', u.user.id).maybeSingle();
    if (!profile || !profile.actif) return res.status(403).json({ error: 'Compte inactif' });
    const rt = rights(profile);
    if (!rt.chat) return res.status(403).json({ error: "L'assistant n'est pas autorisé pour votre compte. Demandez l'accès au Super Administrateur." });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    let rows = [];
    if (rt.dossiers) {
      const { data, error: e2 } = await sb.from('docs').select('id,data').eq('parent', 'chunks').range(0, 4999);
      if (e2) throw e2;
      data.sort((a, b) => a.id.localeCompare(b.id)).forEach((d) => (d.data.rows || []).forEach((r) => rows.push(r)));
    }
    const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10); // heure du Gabon (UTC+1)
    let used = cfg;
    const out = await withFallback(cfg, (c) => { used = c; return chat({ messages: body.messages, profile, rows, cfg: c, today, fetchImpl: fetch }); });
    try {
      const t = new Date().toISOString(), q = String((body.messages || []).slice(-1)[0]?.content || '').slice(0, 300);
      await sb.from('docs').insert({ parent: 'audit', id: t.replace(/\D/g, '') + Math.random().toString(36).slice(2, 6), data: { t, u: profile.nom || profile.email, uid: profile.id, cat: rt.owner ? 'SA' : 'U', a: 'question assistant', question: q, outils: out.tools.join(', '), ia: used.label } });
    } catch (e) { /* journal facultatif */ }
    res.status(200).json({ answer: out.answer });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Erreur serveur' });
  }
}
