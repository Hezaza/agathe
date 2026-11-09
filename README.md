# AGATHE

Application de suivi des dossiers de transit (Trans Obany) : dossiers, documents d'ouverture,
facturation, archives par dossier, comptes utilisateurs avec permissions individuelles.

**Architecture** : site statique (`public/`) + une fonction serveur (`api/users.js`) hébergés sur **Vercel**,
base de données, authentification et stockage de fichiers sur **Supabase**.

```
public/index.html        l'application (interface en français)
public/claude-shim.js    accès aux données (Supabase) : collections/documents, fichiers, téléchargements
api/users.js             gestion des comptes (Super Administrateur uniquement) - clé secrète côté serveur
api/chat.js              assistant AGATHE (Claude) : consultation des dossiers selon les droits de l'utilisateur
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
6. **Project Settings > API Keys** : notez l'**URL du projet** (`https://….supabase.co`), la **Publishable key**
   (`sb_publishable_…`) et une **Secret key** (`sb_secret_…`, bouton « Reveal »). Les anciennes clés « anon » et
   « service_role » fonctionnent aussi.

### 2. Vercel
1. **Add New > Project**, importez le dépôt GitHub `agathe`.
2. Avant de déployer, **Environment Variables** :
   | Nom | Valeur |
   |---|---|
   | `SUPABASE_URL` | Project URL |
   | `SUPABASE_ANON_KEY` | Publishable key (`sb_publishable_…`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Secret key (`sb_secret_…`) — à ne mettre **nulle part ailleurs** |
3. **Deploy**. Les réglages (`vercel.json`) sont déjà prêts : commande de build `node build.js`, dossier `public`.
4. Ouvrez l'adresse du site, connectez-vous avec le compte de l'étape 1.4, puis « Comptes & journal »
   pour créer vos utilisateurs.

### 3. Reprise des données de l'ancienne version (claude.ai)
Connecté en Super Administrateur : **Comptes & journal > Sauvegarde et reprise des données > Restaurer une
sauvegarde**, puis choisissez le fichier `agathe-sauvegarde-reprise.json` (fourni séparément, il contient des
données d'entreprise et ne doit **pas** être mis dans GitHub). Le même écran permet de créer une sauvegarde
complète (dossiers, clients, fiche entreprise) à tout moment. Les documents joints (PDF, Word, Excel) ne sont
pas inclus : à rattacher de nouveau depuis l'onglet « Archives » de chaque dossier.

### 4. Assistant AGATHE (facultatif)
1. Créez une clé sur https://console.anthropic.com (« API Keys »), avec un moyen de paiement : chaque question
   coûte quelques centimes. Fixez une limite de dépense mensuelle dans la console.
2. Vercel > Settings > Environment Variables : `ANTHROPIC_API_KEY` = la clé (secrète). Facultatif :
   `ANTHROPIC_MODEL` (par défaut `claude-sonnet-5-5`). Puis « Redeploy ».
3. Dans AGATHE, « Comptes & journal » : cochez « Utiliser l'assistant AGATHE » pour chaque utilisateur autorisé
   (le Super Administrateur l'a toujours). Les questions posées sont inscrites au journal.
L'assistant consulte les dossiers sans jamais les modifier, et ne montre les montants de facture qu'aux comptes
qui ont accès à la facturation.

## Tests automatiques

```
python3 test/rls_test.py <dossier_socket_postgres> <port>   # règles de sécurité sur un vrai PostgreSQL
node test/api_test.mjs                                      # serveur de comptes
node test/chat_test.mjs                                     # assistant (API Claude simulée)
python3 test/app_test.py                                    # application complète (Supabase simulé)
```

## Sauvegarde automatique
Chaque nuit vers 3 h (heure du Gabon), Vercel Cron appelle `/api/backup` : toutes les données sont copiées dans l'espace de stockage privé `agathe-backups` de Supabase (créé automatiquement, accessible au seul serveur). Les 30 dernières sauvegardes sont conservées ; le Super Administrateur les liste, télécharge et restaure depuis « Comptes & journal ». Variable facultative : `CRON_SECRET` (sécurise l'appel planifié).

## Encaissements
Paiements enregistrés par dossier (champ `Paiements JSON`, droit « billw » pour saisir), créances par client et ancienneté, alertes au-delà de 30 jours, lettre de relance. Les factures émises avant la date de début du suivi (réglable par le Super Administrateur) sont « hors suivi ».

## Lecture automatique de documents et devis
`/api/extract` lit un BL, une LTA ou une facture fournisseur (PDF ou photo, 3 Mo max) avec Claude et propose les valeurs à reporter dans la fiche (nécessite `ANTHROPIC_API_KEY`, droit « create » ou « edit »). Le document n'est pas conservé. Onglet « Devis » dans la facturation, convertible en facture.

## Fournisseur d'IA : Claude ou Groq (gratuit)
L'assistant et la lecture de documents utilisent Claude si `ANTHROPIC_API_KEY` est définie, sinon Groq si `GROQ_API_KEY` est définie (clé gratuite sur console.groq.com). Avec Groq : assistant sur `openai/gpt-oss-120b` (modifiable par `GROQ_MODEL`), lecture de documents sur `qwen/qwen3.8-27b` (`GROQ_VISION_MODEL`) ; les PDF sont convertis en images (3 premières pages) dans le navigateur. `AI_PROVIDER=groq` ou `anthropic` force le choix.
Si les deux clés sont présentes, Claude est essayé d'abord et l'application bascule automatiquement sur Groq quand Claude échoue (crédit épuisé, clé refusée, surcharge).
