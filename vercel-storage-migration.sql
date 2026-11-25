-- Exécuter une seule fois dans Supabase SQL Editor avant le déploiement Vercel.
-- Les PDF restent privés ; le serveur Vercel crée des liens signés après contrôle du profil.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rubberway-enquetes', 'rubberway-enquetes', false, 41943040, array['application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = 41943040,
  allowed_mime_types = array['application/pdf'];

alter table public.enquetes add column if not exists pdf_path text;
alter table public.enquetes add column if not exists nom_fichier text not null default '';
alter table public.enquetes add column if not exists taille_pdf bigint not null default 0;
alter table public.enquetes add column if not exists criteres text not null default '';
alter table public.enquetes add column if not exists reponses jsonb not null default '[]'::jsonb;

alter table public.enquetes drop constraint if exists enquetes_statut_check;
alter table public.enquetes add constraint enquetes_statut_check
  check (statut in ('Conforme', 'Non conforme', 'À vérifier'));

create index if not exists enquetes_date_zone_agent_idx
  on public.enquetes (date_enquete desc, zone, agent);

-- Aucune politique Storage publique : la clé service_role reste sur Vercel uniquement.
