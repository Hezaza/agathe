// Vercel Serverless Function : gestion des comptes utilisateurs (Super Administrateur uniquement).
// Utilise la clé « service_role » de Supabase, qui ne quitte JAMAIS le serveur.
import { createClient } from '@supabase/supabase-js';

const PERM_KEYS = ['p_dash','p_list','p_alr','p_cli','p_rec','bill','open','create','edit','annul','del',
  'docs','billw','rec','dview','dadd','ddel','clients','cdel','export','import'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const pwOk = (p) => typeof p === 'string' && p.length >= 10 && /[A-Za-z]/.test(p) && /\d/.test(p);
const PWMSG = 'Le mot de passe doit contenir au moins 10 caractères, avec des lettres et des chiffres';

export function cleanPerms(p) {
  const o = {};
  if (p && typeof p === 'object') for (const k of PERM_KEYS) if (p[k] === true) o[k] = true;
  return o;
}

export function admin() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Object.assign(new Error('Configuration serveur incomplète'), { status: 500 });
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Vérifie que l'appelant est le Super Administrateur actif
export async function requireOwner(sb, req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw Object.assign(new Error('Non authentifié'), { status: 401 });
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) throw Object.assign(new Error('Session invalide'), { status: 401 });
  const { data: p } = await sb.from('profiles').select('role,actif').eq('id', data.user.id).maybeSingle();
  if (!p || p.role !== 'owner' || !p.actif) throw Object.assign(new Error('Réservé au Super Administrateur'), { status: 403 });
  return data.user;
}

export async function handle(sb, body, caller) {
  const { action } = body || {};
  const target = async (id) => {
    if (!id || typeof id !== 'string') throw Object.assign(new Error('Utilisateur manquant'), { status: 400 });
    const { data: p } = await sb.from('profiles').select('id,role,email').eq('id', id).maybeSingle();
    if (!p) throw Object.assign(new Error('Utilisateur introuvable'), { status: 404 });
    if (p.role === 'owner') throw Object.assign(new Error('Le compte Super Administrateur ne peut pas être modifié ici'), { status: 403 });
    return p;
  };
  if (action === 'create') {
    const email = String(body.email || '').trim().toLowerCase(), nom = String(body.nom || '').trim();
    if (!EMAIL.test(email)) throw Object.assign(new Error('Adresse e-mail invalide'), { status: 400 });
    if (!nom) throw Object.assign(new Error('Le nom est obligatoire'), { status: 400 });
    if (!pwOk(body.password)) throw Object.assign(new Error(PWMSG), { status: 400 });
    const { data, error } = await sb.auth.admin.createUser({ email, password: body.password, email_confirm: true });
    if (error) throw Object.assign(new Error(/already|registered|exists/i.test(error.message) ? 'Un compte existe déjà avec cette adresse e-mail' : error.message), { status: 400 });
    const row = { id: data.user.id, email, nom, fonction: String(body.fonction || '').trim(), tel: String(body.tel || '').trim(), role: 'user', perms: cleanPerms(body.perms), actif: true };
    const { error: e2 } = await sb.from('profiles').insert(row);
    if (e2) { await sb.auth.admin.deleteUser(data.user.id); throw Object.assign(new Error(e2.message), { status: 500 }); }
    return { ok: true, id: data.user.id };
  }
  if (action === 'update') {
    const p = await target(body.id), upd = {};
    if ('nom' in body) { const n = String(body.nom || '').trim(); if (!n) throw Object.assign(new Error('Le nom est obligatoire'), { status: 400 }); upd.nom = n; }
    if ('fonction' in body) upd.fonction = String(body.fonction || '').trim();
    if ('tel' in body) upd.tel = String(body.tel || '').trim();
    if ('perms' in body) upd.perms = cleanPerms(body.perms);
    if ('actif' in body) upd.actif = body.actif === true;
    if (!Object.keys(upd).length) return { ok: true };
    const { error } = await sb.from('profiles').update(upd).eq('id', p.id);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    if ('actif' in upd) {
      await sb.auth.admin.updateUserById(p.id, { ban_duration: upd.actif ? 'none' : '876000h' });
      if (!upd.actif) await sb.rpc('revoke_sessions', { u: p.id });
    }
    return { ok: true };
  }
  if (action === 'setpw') {
    const p = await target(body.id);
    if (!pwOk(body.password)) throw Object.assign(new Error(PWMSG), { status: 400 });
    const { error } = await sb.auth.admin.updateUserById(p.id, { password: body.password });
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    await sb.rpc('revoke_sessions', { u: p.id });
    return { ok: true };
  }
  if (action === 'delete') {
    const p = await target(body.id);
    const { error } = await sb.auth.admin.deleteUser(p.id);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { ok: true };
  }
  throw Object.assign(new Error('Action inconnue'), { status: 400 });
}
