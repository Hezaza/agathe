// Préparation du site au moment du déploiement Vercel :
// 1) génère public/config.js (adresse du projet + clé PUBLIQUE uniquement) ;
// 2) copie la bibliothèque Supabase installée par npm dans public/vendor/supabase.js.
import { writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
if (!url || !anon) {
  console.error('ERREUR : définissez SUPABASE_URL et SUPABASE_ANON_KEY dans Vercel (Settings > Environment Variables).');
  process.exit(1);
}
if (/^sb_secret_/.test(anon) || /service_role/.test(anon)) {
  console.error('ERREUR : SUPABASE_ANON_KEY contient une clé SECRÈTE. Utilisez la clé publique (Publishable / anon).');
  process.exit(1);
}
writeFileSync('public/config.js', 'window.AGATHE_CONFIG=' + JSON.stringify({ url, anon }) + ';\n');

const umd = join('node_modules', '@supabase', 'supabase-js', 'dist', 'umd');
const cand = ['supabase.js', 'supabase.min.js'].map(f => join(umd, f)).find(existsSync)
  || (existsSync(umd) ? readdirSync(umd).filter(f => f.endsWith('.js')).map(f => join(umd, f))[0] : null);
if (!cand) { console.error('ERREUR : bibliothèque Supabase introuvable dans ' + umd); process.exit(1); }
mkdirSync('public/vendor', { recursive: true });
copyFileSync(cand, 'public/vendor/supabase.js');
console.log('Site prêt : config.js + vendor/supabase.js (' + cand + ')');
