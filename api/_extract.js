import { callVision } from './_llm.js';
// Lecture automatique d'un document (BL, LTA, facture fournisseur, liste de colisage…) par Claude.
// Logique testable sans réseau : construction de la requête et nettoyage de la réponse.

export const MAX_BYTES = 3_200_000; // taille maximale du fichier (Vercel limite le corps à 4,5 Mo en base64)
export const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Champs de la fiche AGATHE que l'assistant peut proposer, avec leur description pour Claude.
export const FIELDS = {
  'Nom Client': 'destinataire / consignee / client importateur (raison sociale)',
  'Nom Fournisseur': 'expéditeur / shipper / fournisseur (raison sociale)',
  'N° Commande Client': 'numéro de commande / purchase order (PO)',
  'Lieu Origine': 'pays ou ville de provenance / port de chargement',
  'Lieu Destination': 'ville ou port de destination',
  'Nature marchandises': 'description courte des marchandises',
  'Nbre de colis': 'nombre total de colis (nombre seul)',
  'Poids': 'poids brut total en kg (nombre seul)',
  'Volume': 'volume total en m3 (nombre seul)',
  'Nom Navire': 'nom du navire (maritime) ou compagnie aérienne',
  'N° voyage/vol': 'numéro de voyage ou de vol',
  'N° BL/LTA': 'numéro du connaissement (B/L) ou de la lettre de transport aérien (LTA / AWB)',
  'Type Conteneur': "type de conteneur (ex. 20' DRY, 40' HC)",
  'Containers': 'numéros des conteneurs, séparés par des virgules',
  'Date départ prévu': 'date de départ prévue (ETD)',
  'Date départ réelle': "date d'embarquement / shipped on board",
  "Date d'arrivée prévue": "date d'arrivée prévue (ETA)",
  'Montant facture fournisseur': 'montant total de la facture fournisseur, avec la devise (ex. 12 500 EUR)',
  'Montant fret': 'montant du fret, avec la devise',
};
const DATE_FIELDS = new Set(['Date départ prévu', 'Date départ réelle', "Date d'arrivée prévue"]);
const NUM_FIELDS = new Set(['Nbre de colis', 'Poids', 'Volume']);

export function checkFile(body) {
  const type = String(body && body.type || '');
  const data = String(body && body.data || '');
  if (!TYPES.includes(type)) throw Object.assign(new Error('Format non pris en charge : envoyez un PDF ou une image (JPG, PNG)'), { status: 400 });
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) throw Object.assign(new Error('Fichier vide ou illisible'), { status: 400 });
  if (data.length * 0.75 > MAX_BYTES) throw Object.assign(new Error('Fichier trop volumineux (3 Mo maximum)'), { status: 413 });
  return { type, data };
}

export function buildPrompt(dossierType) {
  const list = Object.entries(FIELDS).map(([k, d]) => `- "${k}" : ${d}`).join('\n');
  const prompt = `Tu aides un transitaire au Gabon à remplir la fiche d'un dossier ${dossierType || "d'importation"}.
Lis le document joint (connaissement, LTA, facture fournisseur, liste de colisage, avis d'arrivée…) et extrais uniquement les informations qui y figurent réellement.

Champs possibles :
${list}

Règles :
- Réponds UNIQUEMENT par un objet JSON, sans texte autour : {"type_document": "...", "champs": {"Nom du champ": "valeur", ...}, "remarque": "..."}
- N'inclus un champ que si l'information est clairement lisible dans le document. N'invente rien.
- Dates au format AAAA-MM-JJ. Nombres sans unité ni séparateur de milliers (point pour les décimales).
- "type_document" : nature du document en quelques mots (ex. "Connaissement maritime").
- "remarque" : une phrase courte si une information est douteuse ou partiellement lisible, sinon "".`;
  return prompt;
}

export function buildRequest({ type, data, model, dossierType }) {
  const src = { type: 'base64', media_type: type, data };
  const block = type === 'application/pdf' ? { type: 'document', source: src } : { type: 'image', source: src };
  return { model, max_tokens: 1500, messages: [{ role: 'user', content: [block, { type: 'text', text: buildPrompt(dossierType) }] }] };
}

const MONTHS = { jan: 1, feb: 2, fev: 2, 'fév': 2, mar: 3, apr: 4, avr: 4, may: 5, mai: 5, jun: 6, juin: 6, jul: 7, juil: 7, aug: 8, aou: 8, 'aoû': 8, sep: 9, oct: 10, nov: 11, dec: 12, 'déc': 12 };
export function normDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-zéû]{3,})\.?[\s\-](\d{4})$/);
  if (m) { const mo = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('jui') ? 4 : 3)] || MONTHS[m[2].toLowerCase().slice(0, 3)]; if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return '';
}

export function parseAnswer(text) {
  const t = String(text || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw Object.assign(new Error("La lecture du document n'a rien donné d'exploitable"), { status: 502 });
  let j;
  try { j = JSON.parse(t.slice(a, b + 1)); } catch (e) { throw Object.assign(new Error("Réponse de lecture illisible, réessayez"), { status: 502 }); }
  const src = (j && typeof j.champs === 'object' && j.champs) || {};
  const champs = {};
  for (const k of Object.keys(FIELDS)) {
    let v = src[k];
    if (v == null) continue;
    if (Array.isArray(v)) v = v.join(', ');
    v = String(v).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!v || /^(n\/?a|inconnu|non (indiqué|renseigné|lisible)|-+)$/i.test(v)) continue;
    if (DATE_FIELDS.has(k)) { v = normDate(v); if (!v) continue; }
    if (NUM_FIELDS.has(k)) {
      let n = v.replace(/m[3³]|cbm|kgs?|tonnes?|colis|pcs|pkgs?/gi, '').replace(/[\s ]/g, '').replace(/[^\d.,]/g, '');
      if (n.includes(',') && n.includes('.')) n = n.lastIndexOf(',') > n.lastIndexOf('.') ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
      else if (n.includes(',')) n = /^\d{1,3}(,\d{3})+$/.test(n) ? n.replace(/,/g, '') : n.replace(',', '.');
      if (!n || isNaN(Number(n))) continue; v = String(Number(n));
    }
    champs[k] = v;
  }
  return { type_document: String(j.type_document || '').slice(0, 80), remarque: String(j.remarque || '').slice(0, 300), champs };
}

export async function extract({ body, apiKey, model, fetchImpl, cfg }) {
  cfg = cfg || { provider: 'anthropic', apiKey, model, visionModel: model };
  const list = Array.isArray(body && body.images) && body.images.length ? body.images.slice(0, 3) : [body];
  const files = list.map(checkFile);
  if (files.reduce((n, f) => n + f.data.length * 0.75, 0) > MAX_BYTES) throw Object.assign(new Error('Fichier trop volumineux (3 Mo maximum)'), { status: 413 });
  const text = await callVision(cfg, { prompt: buildPrompt(String(body.dossierType || '').slice(0, 40)), files, max_tokens: 1500 }, fetchImpl);
  return parseAnswer(text);
}
