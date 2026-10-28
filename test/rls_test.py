#!/usr/bin/env python3
"""Teste les règles de sécurité de supabase/schema.sql sur un Postgres local.
Usage : python3 test/rls_test.py <dossier_socket> <port>"""
import subprocess, sys, uuid
SOCK, PORT = sys.argv[1], sys.argv[2]
def sh(sql, role=None, uid=None):
    pre = ''
    if role: pre += f"set role {role}; "
    if uid: pre += f"set request.jwt.claim.sub = '{uid}'; "
    r = subprocess.run(['psql','-h',SOCK,'-p',PORT,'-U','postgres','-d','agathe_test','-At','-v','ON_ERROR_STOP=1','-c',pre+sql],capture_output=True,text=True)
    return r.returncode, (r.stdout+r.stderr).strip()
def admin(sql, db='agathe_test'):
    r = subprocess.run(['psql','-h',SOCK,'-p',PORT,'-U','postgres','-d',db,'-At','-v','ON_ERROR_STOP=1','-c',sql],capture_output=True,text=True)
    if r.returncode: raise SystemExit('ERREUR SQL: '+r.stderr)
    return r.stdout.strip()
admin('drop database if exists agathe_test','postgres'); admin('create database agathe_test','postgres')
for f in ('test/supabase_stub.sql','supabase/schema.sql'):
    r = subprocess.run(['psql','-h',SOCK,'-p',PORT,'-U','postgres','-d','agathe_test','-v','ON_ERROR_STOP=1','-q','-f',f],capture_output=True,text=True)
    if r.returncode: raise SystemExit(f'ERREUR dans {f}:\n{r.stderr}')
print('schema.sql exécuté sans erreur')
U={k:str(uuid.uuid4()) for k in ('owner','a','b','c','d')}
for k,v in U.items(): admin(f"insert into auth.users values ('{v}','{k}@t.zz')")
admin(f"""insert into profiles(id,email,nom,role,perms,actif) values
('{U['owner']}','owner@t.zz','Boss','owner','{{}}',true),
('{U['a']}','a@t.zz','A','user','{{"create":true,"edit":true}}',true),
('{U['b']}','b@t.zz','B','user','{{}}',true),
('{U['c']}','c@t.zz','C (désactivé)','user','{{"create":true}}',false),
('{U['d']}','d@t.zz','D docs','user','{{"dadd":true,"dview":true}}',true)""")
admin("""insert into docs(parent,id,data) values ('chunks','c000','{"rows":[1]}'),('config','brand','{"nom":"X"}'),('config','clients','{"list":[]}'),('config','catalogue','{"A":[]}'),('audit','a1','{"a":"x"}'),('logins','l1','{"t":"x"}')""")
R=[]
def chk(n,c,i=''):
    R.append(c); print(('OK   ' if c else 'FAIL ')+n+('' if c else ' | '+str(i)))
def count(sql,role,uid=None):
    rc,o=sh(sql,role,uid); return (int(o.split()[-1]) if rc==0 and o.split()[-1].isdigit() else -1) if rc==0 else -1
# --- anonyme
chk('anon lit le logo/nom (brand)',count("select count(*) from docs where parent='config' and id='brand'",'anon')==1)
chk('anon ne lit aucun dossier',count("select count(*) from docs where parent='chunks'",'anon')==0)
chk('anon ne peut rien écrire',sh("insert into docs values ('audit','z','{}')",'anon')[0]!=0)
chk('anon ne lit pas les profils',sh("select count(*) from profiles",'anon')[0]!=0)
# --- propriétaire
o=U['owner']
chk('owner lit le journal',count("select count(*) from docs where parent='audit'",'authenticated',o)==1)
chk('owner lit les connexions',count("select count(*) from docs where parent='logins'",'authenticated',o)==1)
chk('owner modifie la marque',sh("update docs set data='{\"nom\":\"Y\"}' where parent='config' and id='brand'",'authenticated',o)[0]==0 and count("select count(*) from docs where data->>'nom'='Y'",'authenticated',o)==1)
chk('owner écrit les dossiers',sh("insert into docs values ('chunks','c001','{}')",'authenticated',o)[0]==0)
chk('owner lit tous les profils',count("select count(*) from profiles",'authenticated',o)==5)
chk('un seul Super Admin : 2e owner refusé',sh(f"update profiles set role='owner' where id='{U['a']}'")[0]!=0)
# --- A (create+edit)
a=U['a']
chk('A lit les dossiers',count("select count(*) from docs where parent='chunks'",'authenticated',a)==2)
chk('A écrit les dossiers (create/edit)',sh("update docs set data='{\"rows\":[1,2]}' where parent='chunks' and id='c000'",'authenticated',a)[0]==0 and count("select count(*) from docs where parent='chunks' and data->'rows'->>1='2'",'authenticated',a)==1)
chk('A ne modifie pas la marque',count("with u as (update docs set data='{\"nom\":\"HACK\"}' where parent='config' and id='brand' returning 1) select count(*) from u",'authenticated',a)==0)
chk('A ne modifie pas le catalogue',count("with u as (update docs set data='{}' where parent='config' and id='catalogue' returning 1) select count(*) from u",'authenticated',a)==0)
chk('A ne modifie pas les clients (pas de droit clients)',count("with u as (update docs set data='{}' where parent='config' and id='clients' returning 1) select count(*) from u",'authenticated',a)==0)
chk('A ne crée pas de document joint',sh("insert into docs values ('fdocs/x/files','f1','{}')",'authenticated',a)[0]!=0)
chk('A ne lit pas le journal',count("select count(*) from docs where parent='audit'",'authenticated',a)==0)
chk('A ne lit pas les connexions',count("select count(*) from docs where parent='logins'",'authenticated',a)==0)
chk('A écrit dans le journal',sh("insert into docs values ('audit','a2','{\"a\":\"y\"}')",'authenticated',a)[0]==0)
chk('A ne supprime pas le journal',count("with d as (delete from docs where parent='audit' returning 1) select count(*) from d",'authenticated',a)==0)
chk('A ne lit que son profil',count("select count(*) from profiles",'authenticated',a)==1)
chk('A ne peut pas s\'octroyer des droits (update profiles)',sh("update profiles set perms='{\"del\":true}' where id='"+a+"'",'authenticated',a)[0]!=0)
chk('A ne peut pas devenir owner',sh("update profiles set role='owner' where id='"+a+"'",'authenticated',a)[0]!=0)
chk('A ne crée pas de profil',sh(f"insert into profiles(id,email) values ('{uuid.uuid4()}','x@x')",'authenticated',a)[0]!=0)
chk('A ne supprime pas de profil',count("with d as (delete from profiles returning 1) select count(*) from d",'authenticated',a)==0 or sh("delete from profiles",'authenticated',a)[0]!=0)
chk('A peut enregistrer sa dernière connexion (touch_login)',sh("select touch_login()",'authenticated',a)[0]==0 and admin(f"select last_login is not null from profiles where id='{a}'")=='t')
chk('A ne peut pas révoquer des sessions',sh(f"select revoke_sessions('{U['b']}')",'authenticated',a)[0]!=0)
# --- B (aucun droit)
b=U['b']
chk('B (aucun droit) lit les dossiers',count("select count(*) from docs where parent='chunks'",'authenticated',b)==2)
chk('B (aucun droit) ne modifie aucun dossier',count("with u as (update docs set data='{}' where parent='chunks' returning 1) select count(*) from u",'authenticated',b)==0)
chk('B ne crée aucun dossier',sh("insert into docs values ('chunks','c9','{}')",'authenticated',b)[0]!=0)
chk('B ne supprime aucun dossier',count("with d as (delete from docs where parent='chunks' returning 1) select count(*) from d",'authenticated',b)==0)
# --- C désactivé
c=U['c']
chk('C désactivé ne lit rien',count("select count(*) from docs",'authenticated',c)==0)
chk('C désactivé n\'écrit rien',sh("insert into docs values ('audit','zz','{}')",'authenticated',c)[0]!=0 and sh("insert into docs values ('chunks','zz','{}')",'authenticated',c)[0]!=0)
# --- D (documents)
d=U['d']
chk('D (dadd) écrit un document joint',sh("insert into docs values ('fdocs/x/files','f1','{}')",'authenticated',d)[0]==0)
chk('D (dadd) ne touche pas aux dossiers',sh("insert into docs values ('chunks','c8','{}')",'authenticated',d)[0]!=0)
chk('D (dadd) téléverse un fichier',sh("insert into storage.objects(bucket_id,name) values ('agathe-files','f1')",'authenticated',d)[0]==0)
chk('B (aucun droit) ne téléverse pas',sh("insert into storage.objects(bucket_id,name) values ('agathe-files','f2')",'authenticated',b)[0]!=0)
chk('B lit les fichiers (actif)',sh("select count(*) from storage.objects",'authenticated',b)[0]==0)
chk('C désactivé ne lit aucun fichier',count("select count(*) from storage.objects",'authenticated',c)==0)
# --- service_role (API serveur)
chk('service_role peut révoquer des sessions',sh(f"select revoke_sessions('{b}')",'service_role')[0]==0)
chk('la touche « anon » ne peut exécuter les fonctions internes sensibles',sh(f"select revoke_sessions('{b}')",'anon')[0]!=0)
print(f"\nRÉSULTAT RLS : {sum(R)}/{len(R)}")
sys.exit(0 if all(R) else 1)
