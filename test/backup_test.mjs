// Tests de la sauvegarde automatique (sans réseau) : node test/backup_test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'agathe-bk-'));
mkdirSync(join(tmp, 'api')); mkdirSync(join(tmp, 'node_modules/@supabase/supabase-js'), { recursive: true });
writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');
writeFileSync(join(tmp, 'node_modules/@supabase/supabase-js/package.json'), '{"name":"@supabase/supabase-js","type":"module","main":"index.js"}');
writeFileSync(join(tmp, 'node_modules/@supabase/supabase-js/index.js'), 'export const createClient=()=>globalThis.__SB;');
for (const f of ['_lib.js', '_backup.js', 'backup.js']) copyFileSync(join(here, '../api/' + f), join(tmp, 'api/' + f));
const { run, list, link, isCron, gabonDay, KEEP, BUCKET } = await import(pathToFileURL(join(tmp, 'api/_backup.js')).href);
const { default: handler } = await import(pathToFileURL(join(tmp, 'api/backup.js')).href);
const lib = await import(pathToFileURL(join(tmp, 'api/_lib.js')).href);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('OK   ' + m); } else { fail++; console.log('FAIL ' + m); } };

function mockSb({ docs = [], owner = true } = {}) {
  const store = { buckets: {}, files: {}, docs: docs.slice(), audit: [] };
  const sb = {
    store,
    storage: {
      getBucket: async (id) => ({ data: store.buckets[id] || null }),
      createBucket: async (id, o) => { store.buckets[id] = { id, ...o }; return { data: {}, error: null }; },
      from: (b) => ({
        upload: async (name, body, o) => { store.files[name] = { body, o, at: Date.now() }; return { error: null }; },
        list: async () => ({ data: Object.keys(store.files).map((n) => ({ name: n, metadata: { size: store.files[n].body.length }, created_at: '2026-11-09' })), error: null }),
        remove: async (names) => { names.forEach((n) => delete store.files[n]); return { error: null }; },
        createSignedUrl: async (n) => (store.files[n] ? { data: { signedUrl: 'https://signed/' + n } } : { error: { message: 'not found' } }),
      }),
    },
    from: (t) => {
      if (t === 'docs') {
        const q = { _r: [0, 999] };
        q.select = () => q; q.order = () => q;
        q.range = async (a, b) => { const all = store.docs.slice().sort((x, y) => (x.parent + x.id).localeCompare(y.parent + y.id)); return { data: all.slice(a, b + 1), error: null }; };
        q.insert = async (row) => { store.audit.push(row); return { error: null }; };
        return q;
      }
      if (t === 'profiles') {
        const q = {}; q.select = () => q; q.eq = () => q; q.maybeSingle = async () => ({ data: owner ? { role: 'owner', actif: true } : { role: 'user', actif: true } }); return q;
      }
    },
    auth: { getUser: async (tk) => (tk === 'good' ? { data: { user: { id: 'u1', email: 'boss@x.ga' } } } : { error: { message: 'bad' }, data: {} }) },
  };
  return sb;
}

// 2 500 documents (pagination sur plusieurs pages)
const docs = [];
for (let i = 0; i < 2500; i++) docs.push({ parent: i < 3 ? 'chunks' : 'audit', id: 'd' + String(i).padStart(5, '0'), data: i < 3 ? { rows: [{ 'N° dossier': 'MIT' + i }, { 'N° dossier': 'X' + i }] } : { t: i } });
docs.push({ parent: 'config', id: 'brand', data: { nom: 'Test' } });

const sb = mockSb({ docs });
const now = Date.parse('2026-11-09T23:30:00Z'); // 00:30 le 10/11 au Gabon
ok(gabonDay(now) === '2026-11-10', 'date du jour à l’heure du Gabon');
const r = await run(sb, { now });
ok(sb.store.buckets[BUCKET] && sb.store.buckets[BUCKET].public === false, 'espace de stockage privé créé');
ok(r.name === 'agathe-sauvegarde-2026-11-10.json', 'nom du fichier daté');
const j = JSON.parse(sb.store.files[r.name].body);
ok(j.agathe === 1 && Array.isArray(j.docs) && j.auto === true, 'format compatible avec « Restaurer une sauvegarde »');
ok(j.docs.length === 2501, 'tous les documents sont copiés (pagination)');
ok(j.docs.some((d) => d.parent === 'config' && d.id === 'brand'), 'fiche entreprise incluse');
ok(sb.store.audit.length === 1 && sb.store.audit[0].data.dossiers === 6, 'journal : sauvegarde automatique avec nombre de dossiers');

// Rotation : 35 jours de sauvegardes -> 30 conservées
for (let d = 1; d <= 35; d++) await run(sb, { now: Date.parse('2026-10-01T12:00:00Z') + d * 864e5 });
const L = await list(sb);
ok(L.length === KEEP, 'rotation : ' + KEEP + ' sauvegardes conservées');
ok(L[0].name > L[L.length - 1].name, 'liste triée de la plus récente à la plus ancienne');
ok(!L.some((f) => f.name === 'agathe-sauvegarde-2026-10-02.json'), 'les plus anciennes sont supprimées');

// Lien de téléchargement
ok((await link(sb, L[0].name)).url.startsWith('https://signed/'), 'lien de téléchargement temporaire');
let e1; try { await link(sb, '../profiles.json'); } catch (e) { e1 = e; } ok(e1 && e1.status === 400, 'nom de fichier suspect refusé');

// Planification
process.env.CRON_SECRET = '';
ok(isCron({ headers: { 'user-agent': 'vercel-cron/1.0' } }), 'appel planifié Vercel reconnu');
ok(!isCron({ headers: { 'user-agent': 'Mozilla' } }), 'appel ordinaire refusé');
process.env.CRON_SECRET = 'abc';
ok(isCron({ headers: { authorization: 'Bearer abc' } }) && !isCron({ headers: { 'user-agent': 'vercel-cron/1.0' } }), 'CRON_SECRET exigé quand il est défini');
process.env.CRON_SECRET = '';

// Gestionnaire HTTP (droits)
const res = () => { const o = { code: 0, body: null, setHeader() {}, status(c) { o.code = c; return o; }, json(b) { o.body = b; return o; } }; return o; };
process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
const H = async (req, sbx) => { globalThis.__SB = sbx; const o = res(); await handler({ headers: {}, ...req }, o); return o; };
const sbH = mockSb({ docs });
let o = await H({ method: 'GET', headers: { 'user-agent': 'curl' } }, sbH); ok(o.code === 401, 'GET sans planification Vercel refusé');
o = await H({ method: 'GET', headers: { 'user-agent': 'vercel-cron/1.0' } }, sbH); ok(o.code === 200 && o.body.ok && Object.keys(sbH.store.files).length === 1, 'la planification Vercel lance la sauvegarde');
o = await H({ method: 'POST', body: { action: 'list' } }, sbH); ok(o.code === 401, 'liste sans connexion refusée');
o = await H({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { action: 'list' } }, mockSb({ owner: false })); ok(o.code === 403, 'un utilisateur simple ne peut pas accéder aux sauvegardes');
o = await H({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { action: 'list' } }, sbH); ok(o.code === 200 && o.body.items.length === 1, 'le Super Admin voit la liste');
o = await H({ method: 'POST', headers: { authorization: 'Bearer good' }, body: { action: 'link', name: o.body.items[0].name } }, sbH); ok(o.code === 200 && o.body.url, 'le Super Admin obtient le lien de téléchargement');
o = await H({ method: 'POST', headers: { authorization: 'Bearer good' }, body: JSON.stringify({ action: 'run' }) }, sbH); ok(o.code === 200 && sbH.store.audit.slice(-1)[0].data.a.includes('manuelle'), 'sauvegarde manuelle depuis l’application, notée au journal');
o = await H({ method: 'PUT' }, sbH); ok(o.code === 405, 'méthode non prévue refusée');

console.log(`\n${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
