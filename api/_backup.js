// Sauvegarde automatique AGATHE : logique serveur (testable sans réseau).
// Les copies sont rangées dans un espace de stockage privé « agathe-backups »,
// accessible uniquement par le serveur (aucune règle d'accès pour les utilisateurs).

export const BUCKET = 'agathe-backups';
export const KEEP = 30; // nombre de sauvegardes conservées
const PAGE = 1000;

// Date du jour à l'heure du Gabon (UTC+1)
export const gabonDay = (now = Date.now()) => new Date(now + 3600e3).toISOString().slice(0, 10);
export const fileName = (day) => `agathe-sauvegarde-${day}.json`;
const NAME_RE = /^agathe-sauvegarde-\d{4}-\d{2}-\d{2}\.json$/;

async function ensureBucket(sb) {
  const { data } = await sb.storage.getBucket(BUCKET);
  if (data) return;
  const { error } = await sb.storage.createBucket(BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message)) throw error;
}

// Lit toutes les lignes de la table docs, page par page
export async function readAll(sb) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('docs').select('parent,id,data').order('parent').order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    data.forEach((d) => out.push({ parent: d.parent, id: d.id, data: d.data }));
    if (data.length < PAGE) break;
  }
  return out;
}

export async function list(sb) {
  await ensureBucket(sb);
  const { data, error } = await sb.storage.from(BUCKET).list('', { limit: 1000, sortBy: { column: 'name', order: 'desc' } });
  if (error) throw error;
  return (data || []).filter((f) => NAME_RE.test(f.name))
    .map((f) => ({ name: f.name, day: f.name.slice(18, 28), size: (f.metadata && f.metadata.size) || 0, created: f.created_at || f.updated_at || '' }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

export async function run(sb, { now = Date.now(), by = 'automatique' } = {}) {
  await ensureBucket(sb);
  const docs = await readAll(sb);
  const day = gabonDay(now);
  const body = JSON.stringify({ agathe: 1, date: new Date(now).toISOString(), auto: true, docs });
  const name = fileName(day);
  const { error } = await sb.storage.from(BUCKET).upload(name, body, { contentType: 'application/json', upsert: true });
  if (error) throw error;
  // Rotation : on garde les KEEP plus récentes
  const all = await list(sb);
  const old = all.slice(KEEP).map((f) => f.name);
  if (old.length) await sb.storage.from(BUCKET).remove(old);
  const counts = {};
  docs.forEach((d) => { counts[d.parent] = (counts[d.parent] || 0) + 1; });
  try {
    const t = new Date(now).toISOString();
    await sb.from('docs').insert({ parent: 'audit', id: t.replace(/\D/g, '') + Math.random().toString(36).slice(2, 6),
      data: { t, u: by === 'automatique' ? 'Sauvegarde automatique' : by, cat: 'SA', a: 'sauvegarde ' + (by === 'automatique' ? 'automatique' : 'manuelle (serveur)'),
        fichier: name, dossiers: (docs.filter((d) => d.parent === 'chunks').reduce((n, d) => n + ((d.data && d.data.rows) || []).length, 0)), elements: docs.length } });
  } catch (e) { /* journal facultatif */ }
  return { ok: true, name, size: body.length, elements: docs.length, counts, removed: old.length };
}

export async function link(sb, name) {
  if (!NAME_RE.test(String(name || ''))) throw Object.assign(new Error('Nom de sauvegarde invalide'), { status: 400 });
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(name, 300, { download: name });
  if (error) throw Object.assign(new Error('Sauvegarde introuvable'), { status: 404 });
  return { url: data.signedUrl };
}

// Appel planifié par Vercel (Cron) : en-tête Bearer CRON_SECRET si défini, sinon agent « vercel-cron ».
export function isCron(req) {
  const h = req.headers || {};
  const auth = h.authorization || h.Authorization || '';
  const secret = process.env.CRON_SECRET;
  if (secret) return auth === 'Bearer ' + secret;
  return /vercel-cron/i.test(h['user-agent'] || '');
}
