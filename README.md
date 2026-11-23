# RubberWay — Archives des enquêtes

Application web locale qui lit les dossiers organisés `Dossier choisi\Zone\Agent\PDF`. Les zones deviennent des filtres et chaque sous-dossier d'agent alimente les filtres par agent. Le code PHI, le nom du planteur, la date et la conformité sont lus dans le nom et le contenu du PDF, puis les métadonnées sont synchronisées dans Supabase. Les fichiers PDF restent sur l'ordinateur.

## Démarrer sous Windows

1. Installer Node.js si la commande `node` n'est pas disponible.
2. Ouvrir PowerShell dans le dossier `gestion_enquetes_web`.
3. Lancer `node server.js`.
4. Ouvrir `http://127.0.0.1:4177` dans le navigateur.

Le serveur lit par défaut `Bureau\ENQUÊTE RDUE\Zone\Nom de l'agent\...`. Le bouton **Choisir le dossier à lire** ouvre le sélecteur Windows et mémorise le dossier choisi pour les lancements suivants. L'application analyse les PDF existants sans les déplacer. Les nouveaux PDF ajoutés dans l'application sont rangés selon `Zone\Nom de l'agent\Année`. L'index d'appoint et le choix du dossier sont stockés dans `Documents\RubberWay_Archives`.

Pour choisir un autre dossier de stockage, fermer le serveur puis lancer PowerShell ainsi :

```powershell
$env:RUBBERWAY_SURVEY_DIR = 'D:\Archives\ENQUÊTE RDUE'
node server.js
```

## Connexion Supabase

1. Copiez `.env.example` vers `.env`, puis renseignez l'URL du projet et la cle publique `anon` dans les parametres API Supabase. Ne mettez jamais la cle `service_role` dans ce fichier.
2. Dans Supabase SQL Editor, executez `supabase-schema.sql` pour creer les tables `enquetes`, `statistiques_reponses` et `annotations_enquetes`, les politiques RLS et la fonction de synchronisation des résumés.
3. Dans l'application web, connectez-vous comme superviseur puis ouvrez **Parametres**. La section **Comptes des agents de terrain** affiche les agents detectes dans les dossiers et permet de creer les comptes manquants en lot.
4. Redemarrez `node server.js`, puis connectez-vous dans l'application.

Supabase enregistre la zone, le nom de l'agent, le code PHI, le nom du planteur et le statut conforme/non conforme dans `public.enquetes`. `pdf_key` sert uniquement de cle de liaison au PDF local. Les octets et le contenu du fichier PDF ne sont jamais envoyes a Supabase. Si l'application ne parvient pas a lire le statut dans un PDF, elle affiche l'enquete localement comme a verifier et ne synchronise pas de statut incertain.

Les réponses sont comptabilisées localement puis synchronisées sous forme agrégée dans `public.statistiques_reponses` (date, zone, agent, question, réponse et nombre). Aucun PDF, code PHI ou nom de planteur n'est transmis dans cette table. Après une première synchronisation réussie, les résumés sont consultables depuis une autre instance de l'application même si l'ordinateur contenant les PDF est éteint. Pour intégrer les nouvelles enquêtes ou les corrections, cet ordinateur doit être rallumé et la synchronisation exécutée.

Le serveur écoute uniquement sur `127.0.0.1` et est donc accessible depuis cet ordinateur. Pour un accès depuis plusieurs ordinateurs, il faudra héberger le serveur sur un poste partagé et ajouter une authentification adaptée.

Dans l'onglet Archives, le bouton **Annoter** permet d'ajouter une consigne liée au PDF et de cocher **Demander la reprise de cette enquête**. L'annotation et le nom de l'utilisateur qui l'a saisie sont enregistrés dans public.annotations_enquetes et visibles aux utilisateurs connectés. Le fichier PDF original reste inchangé.

## Sessions et autorisations

Le compte dont l'adresse est définie dans `RUBBERWAY_SUPERVISOR_EMAIL` reçoit automatiquement le rôle superviseur. Il voit tous les modules et l'onglet **Paramètres**. Depuis cet onglet, il crée les comptes responsables et leur attribue les modules **Tableau de bord**, **Enquêtes par agent** et **Résumé des enquêtes**. Les responsables ne voient que les modules cochés.

Pour activer la création sécurisée des comptes, renseignez dans le fichier local `.env` `SUPABASE_SERVICE_ROLE_KEY` avec la clé secrète du projet et `RUBBERWAY_SUPERVISOR_EMAIL` avec l'adresse du superviseur, puis redémarrez le serveur. La clé secrète reste uniquement côté serveur et ne doit jamais être publiée dans le code web. Exécutez aussi `supabase-schema.sql` dans Supabase pour créer les profils et appliquer les règles d'accès.

Le superviseur peut aussi créer les comptes des agents terrain à partir des noms de dossiers détectés. Leur identifiant est `NomAgent_rubberway` et leur mot de passe provisoire est `123456`. La connexion Flutter accepte cet identifiant et reprend le nom du compte dans le profil local de l'agent. Supabase Auth refuse les mots de passe de moins de 6 caractères : `1234` ne peut donc pas être utilisé. Après toute modification du schéma, réexécutez `supabase-schema.sql` dans le SQL Editor Supabase avant la création des comptes.

Le module **Rapports** est activé par `reports-module-migration.sql`. Exécutez ce fichier une fois dans le SQL Editor Supabase pour autoriser son attribution aux responsables.

Le rapport mensuel détaillé utilise également le village enregistré avec chaque enquête. Si la table `enquetes` a déjà été créée, exécutez une fois `monthly-report-village-migration.sql` dans le SQL Editor Supabase. Les villages des nouvelles synchronisations sont récupérés depuis la base des producteurs locale à partir du code PHI.
