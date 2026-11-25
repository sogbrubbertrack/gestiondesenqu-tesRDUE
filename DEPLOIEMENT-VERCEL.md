# Déployer RubberWay sur Vercel

## 1. Préparer Supabase

Dans le projet Supabase utilisé par RubberWay, ouvrez **SQL Editor**, puis exécutez `vercel-storage-migration.sql`. Le bucket `rubberway-enquetes` reste privé. Les PDF téléversés après le déploiement et les métadonnées des enquêtes sont enregistrés dans Supabase.

## 2. Importer le dépôt dans Vercel

Dans Vercel, choisissez **Add New… → Project**, importez `sogbrubbertrack/gestiondesenqu-tesRDUE`, gardez la branche `main` et la racine du dépôt (`./`). Aucun framework ni commande de build n’est nécessaire pour cette application.

## 3. Ajouter les variables d’environnement

Dans **Project Settings → Environment Variables**, ajoutez ces variables pour **Production**, **Preview** et **Development** :

| Nom | Valeur |
| --- | --- |
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_ANON_KEY` | clé publique anon/publishable |
| `SUPABASE_SERVICE_ROLE_KEY` | clé serveur secrète Supabase |
| `RUBBERWAY_SUPERVISOR_EMAIL` | adresse e-mail du compte superviseur |
| `RUBBERWAY_STORAGE_BUCKET` | `rubberway-enquetes` |

La clé `SUPABASE_SERVICE_ROLE_KEY` doit rester dans les variables Vercel côté serveur. Ne la mettez jamais dans `app.js`, dans une variable `NEXT_PUBLIC_*` ou dans Git.

## 4. Déployer

Lancez le déploiement depuis Vercel. Pour publier les changements futurs, poussez-les sur `main` ; Vercel créera un nouveau déploiement lié au dépôt.

## 5. Vérifier la mise en ligne

Ouvrez l’URL Vercel, connectez-vous avec un compte superviseur, vérifiez la liste des enquêtes et des producteurs, puis déposez un petit PDF d’essai. Le PDF doit apparaître dans l’archive et s’ouvrir depuis l’application. Supprimez ensuite l’enquête d’essai si elle ne doit pas rester dans les statistiques.

Les anciens PDF qui se trouvent uniquement dans un dossier de l’ordinateur ne sont pas copiés automatiquement par cette migration. Leurs métadonnées déjà enregistrées dans Supabase restent visibles ; il faudra téléverser les anciens fichiers si vous souhaitez aussi les ouvrir depuis Vercel.
