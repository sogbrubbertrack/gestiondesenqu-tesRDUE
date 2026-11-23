-- A exécuter une seule fois dans Supabase > SQL Editor.
-- Les sections sont des paramètres des comptes mobiles des agents terrain.

begin;

alter table public.user_profiles
  add column if not exists section_name text not null default '';

alter table public.user_profiles
  add column if not exists villages text[] not null default '{}';

alter table public.user_profiles
  add column if not exists agent_source_name text not null default '';

update public.user_profiles
set agent_source_name = display_name
where role = 'agent_terrain' and agent_source_name = '';

-- Référentiel partagé avec l'onglet Producteurs et l'application mobile.
create table if not exists public.producteurs (
  code_phi text primary key,
  nom text not null default '',
  contact text not null default '',
  village text not null default ''
);

create index if not exists producteurs_village_idx
  on public.producteurs (lower(btrim(village)));

alter table public.producteurs enable row level security;

drop policy if exists "Agents lisent les producteurs de leur section"
  on public.producteurs;

create policy "Agents lisent les producteurs de leur section"
  on public.producteurs
  for select to authenticated
  using (
    (select public.user_has_role('supervisor'))
    or lower(btrim(producteurs.village)) = any (
      (select array(
        select lower(btrim(assigned_village.value))
        from public.user_profiles p
        cross join lateral unnest(p.villages) as assigned_village(value)
        where p.user_id = auth.uid()
      ))::text[]
    )
  );

grant select on public.producteurs to authenticated;

commit;
