// Tests de la lecture automatique de documents (sans réseau) : node test/extract_test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'agathe-ex-'));
mkdirSync(join(tmp, 'api')); mkdirSync(join(tmp, 'node_modules/@supabase/supabase-js'), { recursive: true });
writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');
writeFileSync(join(tmp, 'node_modules/@supabase/supabase-js/package.json'), '{"name":"@supabase/supabase-js","type":"module","main":"index.js"}');
writeFileSync(join(tmp, 'node_modules/@supabase/supabase-js/index.js'), 'export const createClient=()=>globalThis.__SB;');
for (const f of ['_lib.js', '_extract.js', 'extract.js']) copyFileSync(join(here, '../api/' + f), join(tmp, 'api/' + f));
const X = await import(pathToFileURL(join(tmp, 'api/_extract.js')).href);
const { default: handler } = await import(pathToFileURL(join(tmp, 'api/extract.js')).href);

let pass = 0, fail = 0;
const ok = (c, m, i) => { if (c) { pass++; console.log('OK   ' + m); } else { fail++; console.log('FAIL ' + m + (i ? ' | ' + JSON.stringify(i) : '')); } };
const B64 = Buffer.from('%PDF-1.4 test').toString('base64');

// Contrôle du fichier
let e; try { X.checkFile({ type: 'text/html', data: B64 }); } catch (x) { e = x; } ok(e && e.status === 400, 'format non pris en charge refusé');
e = null; try { X.checkFile({ type: 'application/pdf', data: 'A'.repeat(4_400_000) }); } catch (x) { e = x; } ok(e && e.status === 413, 'fichier trop volumineux refusé');
e = null; try { X.checkFile({ type: 'image/jpeg', data: '<script>' }); } catch (x) { e = x; } ok(e && e.status === 400, 'contenu non base64 refusé');

// Requête envoyée à Claude
const rq = X.buildRequest({ type: 'application/pdf', data: B64, model: 'm', dossierType: 'IMPORT MARITIME' });
ok(rq.messages[0].content[0].type === 'document' && rq.messages[0].content[0].source.media_type === 'application/pdf', 'PDF envoyé comme document');
ok(X.buildRequest({ type: 'image/jpeg', data: B64, model: 'm' }).messages[0].content[0].type === 'image', 'photo envoyée comme image');
ok(rq.messages[0].content[1].text.includes('N° BL/LTA') && rq.messages[0].content[1].text.includes("N'invente rien"), 'consigne : liste des champs et interdiction d’inventer');

// Nettoyage des réponses
ok(X.normDate('12/10/2026') === '2026-10-12' && X.normDate('2026-9-3') === '2026-09-03' && X.normDate('05 NOV 2026') === '2026-11-05' && X.normDate('3 juil. 2026') === '2026-07-03', 'dates converties au format de la fiche');
const ans = 'Voici :\n```json\n{"type_document":"Connaissement maritime","champs":{"N° BL/LTA":"MEDU1234567","Nom Navire":"MSC AURORA","Poids":"12 450,5 kg","Nbre de colis":"320 colis","Containers":["MSCU1234567","MSCU7654321"],"Date d\'arrivée prévue":"14/11/2026","Montant fret":"N/A","Champ inventé":"x","Lieu Origine":"  Shanghai,   Chine "},"remarque":""}\n```';
const p = X.parseAnswer(ans);
ok(p.type_document === 'Connaissement maritime', 'type de document lu');
ok(p.champs['N° BL/LTA'] === 'MEDU1234567' && p.champs['Nom Navire'] === 'MSC AURORA', 'BL et navire');
ok(p.champs['Poids'] === '12450.5' && p.champs['Nbre de colis'] === '320', 'nombres nettoyés (poids, colis)', p.champs);
ok(p.champs['Containers'] === 'MSCU1234567, MSCU7654321', 'liste de conteneurs');
ok(p.champs["Date d'arrivée prévue"] === '2026-11-14', 'date d’arrivée prévue convertie');
ok(!('Montant fret' in p.champs) && !('Champ inventé' in p.champs), 'valeurs vides et champs inconnus ignorés');
ok(p.champs['Lieu Origine'] === 'Shanghai, Chine', 'espaces superflus retirés');
e = null; try { X.parseAnswer('désolé, je ne peux pas'); } catch (x) { e = x; } ok(e && e.status === 502, 'réponse sans JSON : erreur claire');

// Appel complet avec un faux service Claude
const fakeFetch = (status, body) => async (url, o) => { fakeFetch.last = { url, o: JSON.parse(o.body), h: o.headers }; return { ok: status < 300, status, json: async () => body }; };
const out = await X.extract({ body: { type: 'application/pdf', data: B64 }, apiKey: 'k', model: 'claude-x', fetchImpl: fakeFetch(200, { content: [{ type: 'text', text: ans }] }) });
ok(out.champs['N° BL/LTA'] === 'MEDU1234567' && fakeFetch.last.h['x-api-key'] === 'k' && fakeFetch.last.o.model === 'claude-x', 'appel à Claude avec la clé serveur');
e = null; try { await X.extract({ body: { type: 'application/pdf', data: B64 }, apiKey: 'k', model: 'm', fetchImpl: fakeFetch(401, { error: { message: 'invalid x-api-key' } }) }); } catch (x) { e = x; }
ok(e && /Clé ANTHROPIC_API_KEY refusée/.test(e.message), 'clé refusée : message explicite');
e = null; try { await X.extract({ body: { type: 'application/pdf', data: B64 }, apiKey: 'k', model: 'm', fetchImpl: fakeFetch(400, { error: { message: 'Your credit balance is too low' } }) }); } catch (x) { e = x; }
ok(e && /Crédit Anthropic insuffisant/.test(e.message), 'crédit insuffisant : message explicite');

// Gestionnaire HTTP : droits
const res = () => { const o = { code: 0, body: null, setHeader() {}, status(c) { o.code = c; return o; }, json(b) { o.body = b; return o; } }; return o; };
const sbFor = (prof) => ({ auth: { getUser: async (t) => (t === 'good' ? { data: { user: { id: 'u1' } } } : { error: {}, data: {} }) },
  from: (t) => { const q = {}; q.select = () => q; q.eq = () => q; q.maybeSingle = async () => ({ data: prof }); q.insert = async () => ({ error: null }); return q; } });
const H = async (req, prof, key = 'k') => { process.env.ANTHROPIC_API_KEY = key; process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'y'; globalThis.__SB = sbFor(prof); const o = res(); await handler({ method: 'POST', headers: {}, ...req }, o); return o; };
let o = await H({ body: {} }, null, ''); ok(o.code === 503 && /pas encore activée/.test(o.body.error), 'sans clé Anthropic : message d’activation');
o = await H({ body: {} }, null); ok(o.code === 401, 'sans connexion : refusé');
o = await H({ headers: { authorization: 'Bearer good' }, body: {} }, { id: 'u1', role: 'user', perms: { p_list: true }, actif: true }); ok(o.code === 403, 'compte sans droit de saisie : refusé');
o = await H({ headers: { authorization: 'Bearer good' }, body: {} }, { id: 'u1', role: 'user', perms: { edit: true }, actif: false }); ok(o.code === 403, 'compte inactif : refusé');
const realFetch = globalThis.fetch; globalThis.fetch = fakeFetch(200, { content: [{ type: 'text', text: ans }] });
o = await H({ headers: { authorization: 'Bearer good' }, body: { type: 'application/pdf', data: B64, dossier: 'MIT1' } }, { id: 'u1', role: 'user', perms: { edit: true }, actif: true });
ok(o.code === 200 && o.body.champs['Nom Navire'] === 'MSC AURORA', 'agent autorisé : champs retournés');
o = await H({ method: 'GET' }, null); ok(o.code === 405, 'GET refusé');
globalThis.fetch = realFetch;

console.log(`\n${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
