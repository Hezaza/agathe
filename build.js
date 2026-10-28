// Génère public/config.js à partir des variables d'environnement Vercel.
// Seules les valeurs PUBLIQUES (adresse du projet + clé « anon ») sont écrites dans le site.
import { writeFileSync } from 'node:fs';
const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
if (!url || !anon) {
  console.error('ERREUR : définissez SUPABASE_URL et SUPABASE_ANON_KEY dans Vercel (Settings > Environment Variables).');
  process.exit(1);
}
writeFileSync('public/config.js', 'window.AGATHE_CONFIG=' + JSON.stringify({ url, anon }) + ';\n');
console.log('public/config.js généré');
