-- =====================================================================
-- AGATHE : schéma Supabase (à exécuter une seule fois dans « SQL Editor »)
-- =====================================================================

-- 1) Profils des utilisateurs (un profil par compte d'authentification)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  nom         text not null default '',
  fonction    text not null default '',
  tel         text not null default '',
  role        text not null default 'user' check (role in ('owner','user')),
  perms       jsonb not null default '{}'::jsonb,
  actif       boolean not null default true,
  created_at  timestamptz not null default now(),
  last_login  timestamptz
);
-- UN SEUL Super Administrateur possible
create unique index if not exists profiles_one_owner on public.profiles(role) where role = 'owner';

-- 2) Fonctions de contrôle des droits (exécutées côté serveur)
create or replace function public.is_active() returns boolean
language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and actif)
$$;

create or replace function public.is_owner() returns boolean
language sql security definer stable set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and actif and role = 'owner')
$$;

create or replace function public.has_perm(p text) returns boolean
language sql security definer stable set search_path = public as $$
  select exists(
    select 1 from public.profiles
    where id = auth.uid() and actif
      and (role = 'owner' or (perms ->> p) = 'true')
  )
$$;

-- Qui peut écrire dans quelle collection de données
create or replace function public.can_write_doc(p_parent text, p_id text) returns boolean
language sql security definer stable set search_path = public as $$
  select case
    when public.is_owner() then true
    when not public.is_active() then false
    when p_parent in ('audit','logins','users') then true
    when p_parent = 'chunks' then
         public.has_perm('create') or public.has_perm('edit') or public.has_perm('billw')
      or public.has_perm('annul')  or public.has_perm('del')  or public.has_perm('import')
    when p_parent = 'config' and p_id = 'clients' then
         public.has_perm('clients') or public.has_perm('cdel')
    when p_parent like 'fdocs/%' then
         public.has_perm('dadd') or public.has_perm('ddel') or public.has_perm('docs') or public.has_perm('billw')
    else false
  end
$$;

-- Qui peut lire quoi (le journal et les connexions : Super Administrateur seulement)
create or replace function public.can_read_doc(p_parent text, p_id text) returns boolean
language sql security definer stable set search_path = public as $$
  select case
    when public.is_owner() then true
    when not public.is_active() then false
    when p_parent in ('audit','logins') then false
    else true
  end
$$;

-- 3) Données de l'application (collection / document, comme dans la version claude.ai)
create table if not exists public.docs (
  parent      text not null,
  id          text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid(),
  primary key (parent, id)
);
create index if not exists docs_parent_idx on public.docs(parent);

alter table public.docs enable row level security;
alter table public.profiles enable row level security;

drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select to authenticated
  using (public.can_read_doc(parent, id));

-- le logo et le nom de l'entreprise sont visibles sur la page de connexion
drop policy if exists docs_brand_public on public.docs;
create policy docs_brand_public on public.docs for select to anon
  using (parent = 'config' and id = 'brand');

drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (public.can_write_doc(parent, id));

drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (public.can_write_doc(parent, id)) with check (public.can_write_doc(parent, id));

drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated
  using (public.can_write_doc(parent, id)
         and (parent not in ('audit','logins') or public.is_owner()));

-- Profils : chacun lit le sien, le Super Administrateur lit tout ; aucune écriture directe
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_owner());

-- Dernière connexion (appelée par l'application à l'ouverture de session)
create or replace function public.touch_login() returns void
language sql security definer set search_path = public as $$
  update public.profiles set last_login = now() where id = auth.uid() and actif
$$;

-- Révocation des sessions d'un utilisateur (désactivation, changement de mot de passe)
create or replace function public.revoke_sessions(u uuid) returns void
language sql security definer set search_path = public, auth as $$
  delete from auth.sessions where user_id = u
$$;
revoke all on function public.revoke_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_sessions(uuid) to service_role;

grant usage on schema public to anon, authenticated;
grant select on public.docs to anon;
grant select, insert, update, delete on public.docs to authenticated;
grant select on public.profiles to authenticated;
grant execute on function public.touch_login() to authenticated;

-- 4) Mises à jour en direct (équipe connectée en même temps)
alter publication supabase_realtime add table public.docs;
alter publication supabase_realtime add table public.profiles;

-- 5) Stockage des fichiers (documents joints, PDF archivés)
insert into storage.buckets (id, name, public) values ('agathe-files', 'agathe-files', false)
  on conflict (id) do nothing;

drop policy if exists files_select on storage.objects;
create policy files_select on storage.objects for select to authenticated
  using (bucket_id = 'agathe-files' and public.is_active());
drop policy if exists files_insert on storage.objects;
create policy files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'agathe-files' and (public.has_perm('dadd') or public.has_perm('docs') or public.has_perm('billw')));
drop policy if exists files_delete on storage.objects;
create policy files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'agathe-files' and (public.has_perm('dadd') or public.has_perm('ddel') or public.has_perm('docs') or public.has_perm('billw')));
