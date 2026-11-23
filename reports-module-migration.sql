-- Autorise le module Rapports dans les permissions des comptes responsables.
begin;

alter table public.user_profiles
  drop constraint if exists user_profiles_permissions_check;

alter table public.user_profiles
  add constraint user_profiles_permissions_check
  check (permissions <@ array['dashboard', 'archives', 'summary', 'reports']::text[]);

commit;
