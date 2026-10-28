# AGATHE

Application de suivi des dossiers de transit (Trans Obany) : dossiers, documents d'ouverture,
facturation, archives par dossier, comptes utilisateurs avec permissions individuelles.

**Architecture** : site statique (`public/`) + une fonction serveur (`api/users.js`) hébergés sur **Vercel**,
base de données, authentification et stockage de fichiers sur **Supabase**.

```
public/index.html        l'application (interface en français)
public/claude-shim.js    accès aux données (Supabase) : collections/documents, fichiers, téléchargements
api/users.js             gestion des comptes (Super Administrateur uniquement) - clé secrète côté serveur
supabase/schema.sql      tables + règles de sécurité (RLS) + stockage
build.js                 génère public/config.js depuis les variables Vercel
test/                    tests automatiques (voir plus bas)
```

## Sécurité : ce qui est garanti par le serveur

* Connexion **e-mail + mot de passe** gérée par Supabase Auth (mots de passe hachés par Supabase).
* **Un seul Super Administrateur** (index unique en base). Lui seul crée, modifie, désactive,
  supprime les comptes (`api/users.js` vérifie son rôle avec la clé secrète, côté serveur).
* Les droits de chaque utilisateur sont stockés en base (`profiles.perms`) et **contrôlés par PostgreSQL**
  (règles RLS dans `supabase/schema.sql`) : un utilisateur qui n'a aucun droit d'écriture ne peut rien modifier,
  même en contournant l'interface. Le journal d'audit n'est lisible que par le Super Administrateur.
* Un compte désactivé ou supprimé perd l'accès immédiatement (sessions révoquées).

Limite connue : les droits sont appliqués par **grandes familles côté serveur** (dossiers, clients, documents
joints, configuration). Le détail fin (par exemple « peut modifier un dossier mais pas annuler ») est appliqué
par l'application elle-même. Un utilisateur techniquement habile qui a le droit « modifier les dossiers » pourrait
donc, en contournant l'interface, effectuer toute autre écriture dans la famille « dossiers ».

## Mise en service (une seule fois)

### 1. Supabase
1. Projet créé sur supabase.com. Ouvrez **SQL Editor > New query**, collez **tout** le contenu de
   `supabase/schema.sql`, cliquez **Run**. Aucune erreur ne doit apparaître.
2. **Authentication > Sign In / Providers > Email** : désactivez « **Allow new users to sign up** »
   (seul le Super Administrateur crée des comptes) ; dans « Password », mettez la longueur minimale à 10.
3. **Authentication > URL Configuration** : *Site URL* = l'adresse Vercel de l'application
   (ex. `https://agathe.vercel.app`) ; ajoutez-la aussi dans *Redirect URLs*
   (nécessaire au lien « Mot de passe oublié »).
4. **Authentication > Users > Add user > Create new user** : votre e-mail, un mot de passe solide,
   cochez « Auto Confirm User ». C'est votre compte Super Administrateur.
5. Dans **SQL Editor**, exécutez (en remplaçant l'adresse) :
   ```sql
   insert into public.profiles (id, email, nom, role, perms, actif)
   select id, email, 'Votre nom', 'owner', '{}'::jsonb, true
   from auth.users where email = 'votre-adresse@exemple.com';
   ```
6. **Project Settings > API** : notez l'**URL du projet**, la clé **anon public** et la clé **service_role**.

### 2. Vercel
1. **Add New > Project**, importez le dépôt GitHub `agathe`.
2. Avant de déployer, **Environment Variables** :
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (valeurs de l'étape 1.6, pour
   Production, Preview et Development). La clé `service_role` ne doit jamais être mise ailleurs.
3. **Deploy**. Les réglages (`vercel.json`) sont déjà prêts : commande de build `node build.js`, dossier `public`.
4. Ouvrez l'adresse du site, connectez-vous avec le compte de l'étape 1.4, puis « Comptes & journal »
   pour créer vos utilisateurs.

### 3. Reprise des données de l'ancienne version (claude.ai)
Connecté en Super Administrateur : **Comptes & journal > Sauvegarde et reprise des données > Restaurer une
sauvegarde**, puis choisissez le fichier `agathe-sauvegarde-reprise.json` (fourni séparément, il contient des
données d'entreprise et ne doit **pas** être mis dans GitHub). Le même écran permet de créer une sauvegarde
complète (dossiers, clients, fiche entreprise) à tout moment. Les documents joints (PDF, Word, Excel) ne sont
pas inclus : à rattacher de nouveau depuis l'onglet « Archives » de chaque dossier.

## Tests automatiques

```
python3 test/rls_test.py <dossier_socket_postgres> <port>   # règles de sécurité sur un vrai PostgreSQL
node test/api_test.mjs                                      # serveur de comptes
python3 test/app_test.py                                    # application complète (Supabase simulé)
```
