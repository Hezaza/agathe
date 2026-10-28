// Teste api/users.js avec un client Supabase simulé (aucun paquet à installer).
// Usage : node test/api_test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'agathe-api-'));
mkdirSync(join(tmp, 'api')); mkdirSync(join(tmp, 'node_modules/@supabase/supabase-js'), { recursive: true });
writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');
writeFileSync(join(tmp, 'node_modules/@supabase/supabase-js/package.json'), '{"name":"@supabase/supabase-js","type":"module","main":"index.js"}');
writeFileSync(join(tmp, 'node_modules/@supabase/supabase-js/index.js'), 'export const createClient=()=>({});');
copyFileSync(join(here, '../api/users.js'), join(tmp, 'api/users.js'));
copyFileSync(join(here, '../api/_lib.js'), join(tmp, 'api/_lib.js'));
const { handle, requireOwner, cleanPerms } = await import(pathToFileURL(join(tmp, 'api/_lib.js')).href);
const { default: handler } = await import(pathToFileURL(join(tmp, 'api/users.js')).href);

let ok = 0, tot = 0;
const chk = (n, c, i = '') => { tot++; if (c) ok++; console.log((c ? 'OK   ' : 'FAIL ') + n + (c ? '' : ' | ' + JSON.stringify(i))); };
const rej = async (f) => { try { await f(); return null; } catch (e) { return e; } };

function fake() {
  const st = { users: {}, profiles: {}, bans: {}, revoked: [], seq: 0 };
  st.users['tokOwner'] = 'o1'; st.users['tokUser'] = 'u1'; st.users['tokOff'] = 'o2';
  st.profiles.o1 = { id: 'o1', email: 'boss@x.zz', role: 'owner', actif: true };
  st.profiles.u1 = { id: 'u1', email: 'u@x.zz', role: 'user', actif: true, perms: {} };
  st.profiles.o2 = { id: 'o2', email: 'off@x.zz', role: 'owner', actif: false };
  const q = (t) => { const s = { f: [] }; const api = {
    select() { return api; }, eq(c, v) { s.f.push([c, v]); return api; },
    async maybeSingle() { const r = Object.values(st.profiles).find(p => s.f.every(([c, v]) => p[c] === v)); return { data: r || null }; },
    async insert(row) { if (Object.values(st.profiles).some(p => p.id === row.id)) return { error: { message: 'dup' } }; st.profiles[row.id] = { ...row }; return { error: null }; },
    update(u) { s.upd = u; return api; },
    then(res, rej2) { Promise.resolve().then(() => { if (s.upd) { const r = Object.values(st.profiles).find(p => s.f.every(([c, v]) => p[c] === v)); if (r) Object.assign(r, s.upd); return { error: null }; } return { error: null }; }).then(res, rej2); }
  }; return api; };
  return { st, sb: {
    from: q,
    rpc: async (f, a) => { st.revoked.push([f, a.u]); return { error: null }; },
    auth: { getUser: async (t) => st.users[t] ? { data: { user: { id: st.users[t] } }, error: null } : { data: {}, error: { message: 'bad' } },
      admin: {
        createUser: async ({ email, password }) => { if (Object.values(st.profiles).some(p => p.email === email)) return { error: { message: 'User already registered' } }; const id = 'n' + (++st.seq); st.created = { id, email, password }; return { data: { user: { id } }, error: null }; },
        deleteUser: async (id) => { delete st.profiles[id]; return { error: null }; },
        updateUserById: async (id, o) => { if (o.ban_duration) st.bans[id] = o.ban_duration; if (o.password) st.pw = o.password; return { error: null }; } } } } };
}

const { st, sb } = fake();
const req = (t) => ({ headers: t ? { authorization: 'Bearer ' + t } : {} });
// --- authentification de l'appelant
chk('sans jeton → 401', (await rej(() => requireOwner(sb, req())))?.status === 401);
chk('jeton invalide → 401', (await rej(() => requireOwner(sb, req('zzz'))))?.status === 401);
chk('utilisateur ordinaire → 403', (await rej(() => requireOwner(sb, req('tokUser'))))?.status === 403);
chk('Super Admin désactivé → 403', (await rej(() => requireOwner(sb, req('tokOff'))))?.status === 403);
chk('Super Admin actif → accepté', (await requireOwner(sb, req('tokOwner'))).id === 'o1');
// --- permissions : seules les clés connues, jamais « adm »
const cp = cleanPerms({ del: true, adm: true, owner: true, role: 'owner', export: 'true', p_dash: true, create: false });
chk('cleanPerms ignore adm/owner/valeurs non booléennes', JSON.stringify(Object.keys(cp).sort()) === '["del","p_dash"]' && Object.values(cp).every(v => v === true), cp);
// --- création
chk('création : e-mail invalide refusé', (await rej(() => handle(sb, { action: 'create', email: 'pasunmail', nom: 'A', password: 'Abcdefghij12' })))?.status === 400);
chk('création : nom obligatoire', (await rej(() => handle(sb, { action: 'create', email: 'a@x.zz', nom: ' ', password: 'Abcdefghij12' })))?.status === 400);
for (const pw of ['court1', 'uniquementdeslettres', '12345678901234']) chk('création : mot de passe faible refusé (' + pw + ')', (await rej(() => handle(sb, { action: 'create', email: 'a@x.zz', nom: 'A', password: pw })))?.status === 400);
const r = await handle(sb, { action: 'create', email: 'Nouveau@X.zz', nom: 'Nouveau', fonction: 'Agent', password: 'Abcdefghij12', perms: { open: true, adm: true, role: 'owner' }, role: 'owner' });
chk('création : ok, e-mail en minuscules, e-mail confirmé', r.ok && st.created.email === 'nouveau@x.zz');
chk('création : rôle forcé à « user », aucun droit admin', st.profiles[r.id].role === 'user' && JSON.stringify(st.profiles[r.id].perms) === '{"open":true}', st.profiles[r.id]);
const dup = await rej(() => handle(sb, { action: 'create', email: 'nouveau@x.zz', nom: 'B', password: 'Abcdefghij12' }));
chk('création : doublon → message clair', dup?.status === 400 && /existe déjà/.test(dup.message), dup?.message);
// --- le compte Super Admin est intouchable par l'API
for (const a of [{ action: 'update', id: 'o1', perms: {} }, { action: 'update', id: 'o1', actif: false }, { action: 'setpw', id: 'o1', password: 'Abcdefghij12' }, { action: 'delete', id: 'o1' }])
  chk('Super Admin protégé : ' + a.action, (await rej(() => handle(sb, a)))?.status === 403);
chk('utilisateur inconnu → 404', (await rej(() => handle(sb, { action: 'delete', id: 'nope' })))?.status === 404);
// --- mise à jour
await handle(sb, { action: 'update', id: 'u1', nom: 'Dupont', perms: { create: true, adm: true } });
chk('mise à jour : nom + droits nettoyés', st.profiles.u1.nom === 'Dupont' && JSON.stringify(st.profiles.u1.perms) === '{"create":true}', st.profiles.u1);
chk('mise à jour : rôle non modifiable', (await handle(sb, { action: 'update', id: 'u1', role: 'owner' }), st.profiles.u1.role === 'user'));
await handle(sb, { action: 'update', id: 'u1', actif: false });
chk('désactivation : bannissement + sessions révoquées', st.profiles.u1.actif === false && st.bans.u1 && st.revoked.some(x => x[1] === 'u1'), [st.bans, st.revoked]);
await handle(sb, { action: 'update', id: 'u1', actif: true });
chk('réactivation : bannissement levé', st.bans.u1 === 'none' && st.profiles.u1.actif === true);
st.revoked.length = 0;
chk('mot de passe faible refusé', (await rej(() => handle(sb, { action: 'setpw', id: 'u1', password: 'faible' })))?.status === 400);
await handle(sb, { action: 'setpw', id: 'u1', password: 'Nouveau2026abc' });
chk('réinitialisation : mot de passe changé + sessions révoquées', st.pw === 'Nouveau2026abc' && st.revoked.length === 1);
await handle(sb, { action: 'delete', id: 'u1' });
chk('suppression', !st.profiles.u1);
chk('action inconnue → 400', (await rej(() => handle(sb, { action: 'drop' })))?.status === 400);
// --- point d'entrée HTTP
const res = () => { const o = { code: 0, body: null, headers: {} }; o.setHeader = (k, v) => { o.headers[k] = v; }; o.status = (c) => { o.code = c; return o; }; o.json = (b) => { o.body = b; return o; }; return o; };
const r1 = res(); await handler({ method: 'GET', headers: {} }, r1);
chk('GET refusé (405)', r1.code === 405);
const r2 = res(); await handler({ method: 'POST', headers: {}, body: '{}' }, r2);
chk('POST sans configuration/jeton : refusé, pas de fuite', r2.code >= 401 && !JSON.stringify(r2.body).includes('SERVICE'), r2);
console.log(`\nRÉSULTAT API : ${ok}/${tot}`);
process.exit(ok === tot ? 0 : 1);
