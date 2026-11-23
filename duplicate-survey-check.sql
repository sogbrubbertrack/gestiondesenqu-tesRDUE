-- Date requise pour détecter plusieurs enquêtes du même planteur la même année.
-- À exécuter une seule fois dans l'éditeur SQL Supabase.
alter table public.enquetes
  add column if not exists date_enquete date;

create index if not exists enquetes_code_phi_date_idx
  on public.enquetes (code_phi, date_enquete);
