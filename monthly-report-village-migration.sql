-- Ajoute le village aux métadonnées des enquêtes stockées dans Supabase.
alter table public.enquetes
  add column if not exists village text not null default '';
