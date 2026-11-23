create table if not exists public.enquetes (
  -- Cle technique de liaison avec le PDF garde dans le dossier local.
  pdf_key text primary key,
  zone text not null default '',
  agent text not null default '',
  code_phi text not null default '',
  nom_planteur text not null default '',
  village text not null default '',
  statut text not null check (statut in ('Conforme', 'Non conforme'))
);

alter table public.enquetes add column if not exists date_enquete date;
alter table public.enquetes add column if not exists village text not null default '';
create index if not exists enquetes_code_phi_date_idx
  on public.enquetes (code_phi, date_enquete);

alter table public.enquetes enable row level security;

drop policy if exists "Agents connectes lisent les enquetes" on public.enquetes;
create policy "Agents connectes lisent les enquetes"
  on public.enquetes for select to authenticated using (true);

drop policy if exists "Agents connectes ajoutent les enquetes" on public.enquetes;
create policy "Agents connectes ajoutent les enquetes"
  on public.enquetes for insert to authenticated with check (true);

drop policy if exists "Agents connectes mettent a jour les enquetes" on public.enquetes;
create policy "Agents connectes mettent a jour les enquetes"
  on public.enquetes for update to authenticated using (true) with check (true);

grant select, insert, update on public.enquetes to authenticated;

-- Les réponses détaillées sont regroupées dans Supabase; les PDF restent locaux.
create table if not exists public.statistiques_reponses (
  source_id text not null,
  date_enquete date not null,
  zone text not null default '',
  agent text not null,
  question_ref text not null,
  question text not null default '',
  reponse text not null,
  nombre integer not null check (nombre > 0),
  updated_at timestamptz not null default now(),
  primary key (source_id, date_enquete, zone, agent, question_ref, reponse)
);

alter table public.statistiques_reponses enable row level security;

drop policy if exists "Agents connectes lisent les statistiques" on public.statistiques_reponses;
create policy "Agents connectes lisent les statistiques"
  on public.statistiques_reponses for select to authenticated using (true);

grant select on public.statistiques_reponses to authenticated;

create or replace function public.replace_archive_statistics(p_source_id text, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentification requise';
  end if;
  if not public.user_has_role('supervisor') then
    raise exception 'Acces reserve au superviseur';
  end if;
  if p_source_id !~ '^[a-f0-9]{24}$' then
    raise exception 'Identifiant de source invalide';
  end if;

  delete from public.statistiques_reponses where source_id = p_source_id;

  insert into public.statistiques_reponses (
    source_id, date_enquete, zone, agent, question_ref, question, reponse, nombre, updated_at
  )
  select
    p_source_id, row_data.date_enquete, coalesce(row_data.zone, ''), row_data.agent,
    row_data.question_ref, coalesce(row_data.question, ''), row_data.reponse,
    row_data.nombre, now()
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row_data(
    date_enquete date,
    zone text,
    agent text,
    question_ref text,
    question text,
    reponse text,
    nombre integer
  )
  where row_data.agent is not null and row_data.question_ref is not null
    and row_data.reponse is not null and row_data.nombre > 0
  on conflict (source_id, date_enquete, zone, agent, question_ref, reponse)
  do update set
    question = excluded.question,
    nombre = excluded.nombre,
    updated_at = now();
end;
$$;

revoke all on function public.replace_archive_statistics(text, jsonb) from public;
grant execute on function public.replace_archive_statistics(text, jsonb) to authenticated;

-- Annotations de contrôle liées à une enquête ; elles restent disponibles aux agents connectés.
create table if not exists public.annotations_enquetes (
  pdf_key text primary key,
  annotation text not null check (char_length(annotation) between 1 and 2000),
  reprise_requise boolean not null default false,
  annotateur text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.annotations_enquetes enable row level security;

drop policy if exists "Agents connectes lisent les annotations" on public.annotations_enquetes;
create policy "Agents connectes lisent les annotations"
  on public.annotations_enquetes for select to authenticated using (true);

drop policy if exists "Agents connectes enregistrent les annotations" on public.annotations_enquetes;
create policy "Agents connectes enregistrent les annotations"
  on public.annotations_enquetes for insert to authenticated with check (true);

drop policy if exists "Agents connectes modifient les annotations" on public.annotations_enquetes;
create policy "Agents connectes modifient les annotations"
  on public.annotations_enquetes for update to authenticated using (true) with check (true);

grant select, insert, update on public.annotations_enquetes to authenticated;

-- Profils et droits attribués par le superviseur.
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null default '',
  title text not null default 'Assistant',
  role text not null default 'responsable' check (role in ('supervisor', 'responsable')),
  permissions text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (permissions <@ array['dashboard', 'archives', 'summary', 'reports']::text[])
);

alter table public.user_profiles enable row level security;

-- Comptes des agents terrain : identifiant lisible distinct de l'e-mail technique Supabase.
alter table public.user_profiles add column if not exists login_identifier text;
create unique index if not exists user_profiles_login_identifier_key
  on public.user_profiles (lower(login_identifier)) where login_identifier is not null;
alter table public.user_profiles drop constraint if exists user_profiles_role_check;
alter table public.user_profiles add constraint user_profiles_role_check
  check (role in ('supervisor', 'responsable', 'agent_terrain'));

create or replace function public.user_has_role(required_role text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.user_id = auth.uid() and p.role = required_role
  );
$$;

create or replace function public.user_has_module(required_module text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.user_has_role('supervisor') or exists (
    select 1 from public.user_profiles p
    where p.user_id = auth.uid() and required_module = any(p.permissions)
  );
$$;

revoke all on function public.user_has_role(text) from public;
revoke all on function public.user_has_module(text) from public;
grant execute on function public.user_has_role(text) to authenticated;
grant execute on function public.user_has_module(text) to authenticated;
grant select on public.user_profiles to authenticated;
revoke insert, update, delete on public.user_profiles from authenticated;

drop policy if exists "Utilisateur lit son profil ou superviseur tous" on public.user_profiles;
create policy "Utilisateur lit son profil ou superviseur tous"
  on public.user_profiles for select to authenticated
  using (user_id = auth.uid() or public.user_has_role('supervisor'));

-- Les responsables ne lisent que les modules qui leur sont attribués.
drop policy if exists "Agents connectes lisent les enquetes" on public.enquetes;
drop policy if exists "Utilisateurs autorises lisent les enquetes" on public.enquetes;
create policy "Utilisateurs autorises lisent les enquetes"
  on public.enquetes for select to authenticated
  using (public.user_has_module('dashboard') or public.user_has_module('archives') or public.user_has_module('summary'));

drop policy if exists "Agents connectes ajoutent les enquetes" on public.enquetes;
drop policy if exists "Superviseur ajoute les enquetes" on public.enquetes;
create policy "Superviseur ajoute les enquetes"
  on public.enquetes for insert to authenticated
  with check (public.user_has_role('supervisor'));

drop policy if exists "Agents connectes mettent a jour les enquetes" on public.enquetes;
drop policy if exists "Superviseur modifie les enquetes" on public.enquetes;
create policy "Superviseur modifie les enquetes"
  on public.enquetes for update to authenticated
  using (public.user_has_role('supervisor')) with check (public.user_has_role('supervisor'));

drop policy if exists "Agents connectes lisent les statistiques" on public.statistiques_reponses;
drop policy if exists "Utilisateurs autorises lisent les statistiques" on public.statistiques_reponses;
create policy "Utilisateurs autorises lisent les statistiques"
  on public.statistiques_reponses for select to authenticated
  using (public.user_has_module('summary'));

drop policy if exists "Agents connectes lisent les annotations" on public.annotations_enquetes;
drop policy if exists "Utilisateurs autorises lisent les annotations" on public.annotations_enquetes;
create policy "Utilisateurs autorises lisent les annotations"
  on public.annotations_enquetes for select to authenticated
  using (public.user_has_module('archives'));

drop policy if exists "Agents connectes enregistrent les annotations" on public.annotations_enquetes;
drop policy if exists "Utilisateurs autorises ajoutent les annotations" on public.annotations_enquetes;
create policy "Utilisateurs autorises ajoutent les annotations"
  on public.annotations_enquetes for insert to authenticated
  with check (public.user_has_module('archives'));

drop policy if exists "Agents connectes modifient les annotations" on public.annotations_enquetes;
drop policy if exists "Utilisateurs autorises modifient les annotations" on public.annotations_enquetes;
create policy "Utilisateurs autorises modifient les annotations"
  on public.annotations_enquetes for update to authenticated
  using (public.user_has_module('archives')) with check (public.user_has_module('archives'));

-- Portee geographique des responsables. Le superviseur garde toutes les zones.
alter table public.user_profiles add column if not exists zones text[] not null default '{}';
alter table public.user_profiles add column if not exists title text not null default 'Assistant';
-- Section geographique attribuee a chaque agent de terrain.
alter table public.user_profiles add column if not exists section_name text not null default '';
alter table public.user_profiles add column if not exists villages text[] not null default '{}';
alter table public.user_profiles add column if not exists agent_source_name text not null default '';
update public.user_profiles
set agent_source_name = display_name
where role = 'agent_terrain' and agent_source_name = '';

-- Base partagee des producteurs; les agents ne lisent que les villages de leur section.
create table if not exists public.producteurs (
  code_phi text primary key,
  nom text not null default '',
  contact text not null default '',
  village text not null default ''
);
create index if not exists producteurs_village_idx on public.producteurs (lower(btrim(village)));
alter table public.producteurs enable row level security;
drop policy if exists "Agents lisent les producteurs de leur section" on public.producteurs;
create policy "Agents lisent les producteurs de leur section"
  on public.producteurs for select to authenticated
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
alter table public.annotations_enquetes add column if not exists zone text not null default '';
update public.annotations_enquetes a
set zone = e.zone
from public.enquetes e
where a.pdf_key = e.pdf_key and a.zone = '';

create or replace function public.user_has_zone(required_zone text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.user_has_role('supervisor') or exists (
    select 1 from public.user_profiles p
    where p.user_id = auth.uid()
      and exists (
        select 1 from unnest(p.zones) as zone_value(value)
        where lower(btrim(zone_value.value)) = lower(btrim(required_zone))
      )
  );
$$;

revoke all on function public.user_has_zone(text) from public;
grant execute on function public.user_has_zone(text) to authenticated;

-- Supprimer les anciennes politiques permissives pour que les restrictions
-- par module et par zone s'appliquent effectivement.
drop policy if exists "Agents connectes lisent les enquetes" on public.enquetes;
drop policy if exists "Utilisateurs autorises lisent les enquetes" on public.enquetes;
drop policy if exists "Agents connectes ajoutent les enquetes" on public.enquetes;
drop policy if exists "Superviseur ajoute les enquetes" on public.enquetes;
drop policy if exists "Agents connectes mettent a jour les enquetes" on public.enquetes;
drop policy if exists "Superviseur modifie les enquetes" on public.enquetes;
create policy "Utilisateurs autorises lisent les enquetes"
  on public.enquetes for select to authenticated
  using (public.user_has_zone(zone) and (public.user_has_module('dashboard') or public.user_has_module('archives') or public.user_has_module('summary')));
create policy "Superviseur ajoute les enquetes"
  on public.enquetes for insert to authenticated
  with check (public.user_has_role('supervisor'));
create policy "Superviseur modifie les enquetes"
  on public.enquetes for update to authenticated
  using (public.user_has_role('supervisor')) with check (public.user_has_role('supervisor'));

drop policy if exists "Agents connectes lisent les statistiques" on public.statistiques_reponses;
drop policy if exists "Utilisateurs autorises lisent les statistiques" on public.statistiques_reponses;
create policy "Utilisateurs autorises lisent les statistiques"
  on public.statistiques_reponses for select to authenticated
  using (public.user_has_module('summary') and public.user_has_zone(zone));

drop policy if exists "Agents connectes lisent les annotations" on public.annotations_enquetes;
drop policy if exists "Utilisateurs autorises lisent les annotations" on public.annotations_enquetes;
create policy "Utilisateurs autorises lisent les annotations"
  on public.annotations_enquetes for select to authenticated
  using (public.user_has_module('archives') and public.user_has_zone(zone));

drop policy if exists "Agents connectes enregistrent les annotations" on public.annotations_enquetes;
drop policy if exists "Utilisateurs autorises ajoutent les annotations" on public.annotations_enquetes;
create policy "Utilisateurs autorises ajoutent les annotations"
  on public.annotations_enquetes for insert to authenticated
  with check (public.user_has_role('supervisor'));

drop policy if exists "Agents connectes modifient les annotations" on public.annotations_enquetes;
drop policy if exists "Utilisateurs autorises modifient les annotations" on public.annotations_enquetes;
create policy "Utilisateurs autorises modifient les annotations"
  on public.annotations_enquetes for update to authenticated
  using (public.user_has_role('supervisor'))
  with check (public.user_has_role('supervisor'));
