#!/usr/bin/env python3
"""Test de bout en bout de l'application web avec un client Supabase simulé.
Usage : python3 test/app_test.py"""
import json, subprocess, time, pathlib
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parent.parent
MOCK=(ROOT/'test/mock_supabase.js').read_text()
srv=subprocess.Popen(['python3','-m','http.server','8766','--directory',str(ROOT/'public')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);time.sleep(1)
R=[];ERR=[]
def chk(n,c,i=''):
    R.append(bool(c));print(('OK   ' if c else 'FAIL ')+n+('' if c else ' | '+str(i)))
with sync_playwright() as p:
    b=p.chromium.launch();ctx=b.new_context(viewport={'width':1300,'height':900})
    def route(r):
        u=r.request.url
        if u.endswith('/config.js'):return r.fulfill(body="window.AGATHE_CONFIG={url:'http://mock',anon:'anon'};",content_type='application/javascript')
        if 'supabase-js' in u:return r.fulfill(body=MOCK,content_type='application/javascript')
        if u.startswith('http://localhost'):return r.continue_()
        return r.abort()
    ctx.route('**/*',route)
    def page():
        pg=ctx.new_page();pg.on('pageerror',lambda e:ERR.append(str(e)));pg.goto('http://localhost:8766/index.html');pg.wait_for_timeout(900);return pg
    def st_(pg):return pg.evaluate("localStorage.getItem('__m')")
    def seed(pg):
        pg.evaluate("""()=>{const m={docs:{},profiles:{},users:{},sess:null,files:{}};
        m.users.o1={id:'o1',email:'boss@obany.ga',pw:'Motdepasse2026'};m.profiles.o1={id:'o1',email:'boss@obany.ga',nom:'Trans Obany',role:'owner',perms:{},actif:true};
        m.docs['chunks\\u0000c000']={parent:'chunks',id:'c000',data:{rows:[{'N° dossier':'MIT0000126','Nom Client':'CLIENT SECRET SA','Type de dossier':'IMPORT MARITIME','Statut':'DOSSIER EN COURS DE TRAITEMENT','Lieu Origine':'Chine'}]}};
        m.docs['config\\u0000brand']={parent:'config',id:'brand',data:{nom:'TRANS OBANY'}};localStorage.setItem('__m',JSON.stringify(m))}""")
    def login(pg,em,pw):
        pg.fill('#id',em);pg.fill('#pw',pw);pg.click('#lgb');pg.wait_for_timeout(1500)
    pg=ctx.new_page();pg.on('pageerror',lambda e:ERR.append(str(e)));pg.goto('http://localhost:8766/index.html');seed(pg);pg.reload();pg.wait_for_timeout(1000)
    t=pg.inner_text('#lg')
    chk('A1 écran e-mail + mot de passe affiché, nom de l’entreprise lu avant connexion','Adresse e-mail' in t and 'Mot de passe' in t and 'TRANS OBANY' in t,t[:200])
    chk('A2 aucune donnée de dossier avant connexion','CLIENT SECRET' not in pg.inner_text('body').replace(t,''))
    for em,pw in [('x@y.zz','nimportequoi'),('boss@obany.ga','mauvais'),('boss','Motdepasse2026'),('','')]:
        pg.evaluate("failT=0");login(pg,em,pw);chk('A3 refus %r/%r'%(em,pw),pg.is_visible('#lg') and 'CLIENT SECRET' not in pg.inner_text('body').replace(txt:=pg.inner_text('#lg'),''),pg.inner_text('#lgm'))
    pg.evaluate("failT=0");login(pg,'boss@obany.ga','Motdepasse2026')
    chk('B1 Super Admin connecté',not pg.is_visible('#lg') and 'Super Admin' in pg.inner_text('#us'),pg.inner_text('#us'))
    chk('B2 dossiers chargés depuis la base','MIT0000126' in pg.inner_text('body'))
    chk('B3 onglet Comptes visible','Comptes' in pg.inner_text('#nv'))
    # création d'un utilisateur via l'interface
    pg.evaluate("view='acc';render()");pg.wait_for_timeout(800);pg.evaluate("uForm()");pg.wait_for_timeout(300)
    pg.fill('#u_nom','Agent Dupont');pg.fill('#u_em','agent@obany.ga');pg.fill('#u_fn','Déclarant');pg.fill('#u_pw','faible')
    pg.check('#md .up[data-p=p_dash]');pg.check('#md .up[data-p=p_list]');pg.check('#md .up[data-p=open]');pg.check('#md .up[data-p=create]');pg.click('#u_ok');pg.wait_for_timeout(600)
    chk('C1 mot de passe faible refusé à la création','10 caract' in pg.inner_text('#u_msg'),pg.inner_text('#u_msg'))
    pg.fill('#u_pw','Agent12345678');pg.click('#u_ok');pg.wait_for_timeout(1500)
    m=json.loads(st_(pg));ags=[x for x in m['profiles'].values() if x['email']=='agent@obany.ga']
    chk('C2 compte créé avec les accès cochés',len(ags)==1 and ags[0]['perms']=={'p_dash':True,'p_list':True,'open':True,'create':True} and ags[0]['role']=='user',ags)
    pg.wait_for_timeout(500);chk('C3 liste des comptes mise à jour en direct','Agent Dupont' in pg.inner_text('#ac1'),pg.inner_text('#ac1')[:200])
    # persistance de session
    pg.reload();pg.wait_for_timeout(1500);chk('D1 session conservée après rechargement',not pg.is_visible('#lg') and 'Super Admin' in pg.inner_text('#us'))
    pg.evaluate("lo_()");pg.wait_for_timeout(1500);chk('D2 déconnexion → retour à la connexion',pg.is_visible('#lg') and 'MIT0000126' not in pg.inner_text('#m'))
    # utilisateur
    login(pg,'agent@obany.ga','Agent12345678')
    chk('E1 utilisateur connecté',not pg.is_visible('#lg') and 'Agent Dupont' in pg.inner_text('#us'),pg.inner_text('#lgm') if pg.is_visible('#lg') else '')
    nv=pg.inner_text('#nv');chk('E2 menus limités aux pages autorisées','Tableau de bord' in nv and 'Dossiers' in nv and 'Alertes' not in nv and 'facturation' not in nv and 'Comptes' not in nv,nv)
    r=pg.evaluate("""async()=>{const o={};const t=[['marque',()=>SB.from('docs').upsert({parent:'config',id:'brand',data:{nom:'HACK'}})],['journal',()=>SB.from('docs').select('id').eq('parent','audit')],['dossier-ecriture-ok(create)',()=>SB.from('docs').upsert({parent:'chunks',id:'c000',data:{rows:[]}})],['doc-joint',()=>SB.from('docs').upsert({parent:'fdocs/X/files',id:'f1',data:{}})],['profil-autre',()=>SB.from('profiles').select('*')]];
    for(const [n,f] of t){const r=await f();o[n]=r.error?'REFUSÉ':('OK:'+(Array.isArray(r.data)?r.data.length:'1'))}return o}""")
    chk('E3 règles serveur simulées : marque refusée, journal vide, un seul profil visible',r['marque']=='REFUSÉ' and r['journal']=='OK:0' and r['profil-autre']=='OK:1' and r['doc-joint']=='REFUSÉ',r)
    pg.evaluate("sv('c000|0','Commentaires Client','pirate')");pg.wait_for_timeout(800)
    chk('E4 modification refusée côté application (pas de droit edit)','pirate' not in (st_(pg) or ''))
    chk('E5 aucun droit export/import/facturation',pg.evaluate("[can('export'),can('import'),can('bill'),can('adm'),can('del')]")==[False]*5)
    # désactivation en direct
    po=ctx.new_page();po.on('pageerror',lambda e:ERR.append(str(e)));po.goto('http://localhost:8766/index.html');po.wait_for_timeout(900);login(po,'boss@obany.ga','Motdepasse2026')
    po.evaluate("view='acc';render()");po.wait_for_timeout(800);po.evaluate("uTog(ACCS[0].k)");po.wait_for_timeout(3500)
    chk('F1 utilisateur désactivé déconnecté en direct',pg.is_visible('#lg'),pg.inner_text('#st'))
    pg.evaluate("failT=0");login(pg,'agent@obany.ga','Agent12345678');chk('F2 connexion refusée tant que désactivé',pg.is_visible('#lg'))
    po.evaluate("uTog(ACCS[0].k)");po.wait_for_timeout(1000)
    # réinitialisation par le Super Admin
    po.evaluate("uPw(ACCS[0].k)");po.wait_for_timeout(300);po.fill('#u_pw','Nouveau2026abc');po.click('#u_ok');po.wait_for_timeout(1500)
    pg.evaluate("failT=0");login(pg,'agent@obany.ga','Agent12345678');chk('G1 ancien mot de passe refusé',pg.is_visible('#lg'))
    pg.evaluate("failT=0");login(pg,'agent@obany.ga','Nouveau2026abc');chk('G2 nouveau mot de passe accepté',not pg.is_visible('#lg'))
    # mot de passe oublié (e-mail de réinitialisation)
    pg.evaluate("lo_()");pg.wait_for_timeout(1500);pg.click('text=Mot de passe oublié');pg.wait_for_timeout(300);pg.fill('#id','agent@obany.ga');pg.click('#lgb');pg.wait_for_timeout(800)
    chk('H1 demande de lien envoyée à Supabase + message neutre',pg.evaluate('window.__resetMail')=='agent@obany.ga' and 'vient' in pg.inner_text('#lgm'),pg.inner_text('#lgm'))
    pg.evaluate("window.__authcb('PASSWORD_RECOVERY')");pg.wait_for_timeout(500)
    chk('H2 écran « nouveau mot de passe » au retour du lien',pg.query_selector('#pw2') is not None)
    pg.fill('#pw','court');pg.fill('#pw2','court');pg.click('#lgb');pg.wait_for_timeout(300);chk('H3 mot de passe faible refusé','10 caract' in pg.inner_text('#lgm'))
    # pas de session réelle dans la simulation : on la crée comme le ferait le lien e-mail
    pg.evaluate("()=>{const m=JSON.parse(localStorage.getItem('__m'));sessionStorage.setItem('__s',Object.keys(m.users).find(k=>m.users[k].email=='agent@obany.ga'))}")
    pg.fill('#pw','Reset2026motdepasse');pg.fill('#pw2','Reset2026motdepasse');pg.click('#lgb');pg.wait_for_timeout(1500)
    pg.evaluate("failT=0");pg.fill('#id','agent@obany.ga');pg.fill('#pw','Reset2026motdepasse');pg.click('#lgb');pg.wait_for_timeout(1500)
    chk('H4 connexion avec le mot de passe choisi via le lien',not pg.is_visible('#lg'))
    # fichiers : téléversement / lecture
    r=pg.evaluate("async()=>{const a=await claude.use('assets');try{await a.upload(new Blob(['x']),{type:'text/plain'});return 'ACCEPTÉ'}catch(e){return e.code}}")
    chk('I1 utilisateur sans droit : téléversement refusé',r=='permission_denied',r)
    # Super Admin : fichiers
    r=po.evaluate("async()=>{const a=await claude.use('assets');const u=await a.upload(new Blob(['%PDF-test']),{type:'application/pdf'});const t=await (await fetch('/_blob/'+u.id)).text();await a.delete(u.id);const r2=await fetch('/_blob/'+u.id);return [t,r2.status]}")
    chk('I2 Super Admin : téléversement, lecture /_blob/ puis suppression',r==['%PDF-test',404],r)
    # audit & suppression par le propriétaire
    r=po.evaluate("async()=>{const d=await claude.use('db');const s=await d.collection('audit').orderBy('t','desc').limit(5).get();return s.docs.length>0}")
    chk('J1 Super Admin lit le journal (tri/limite)',r)
    # suppression de compte
    po.evaluate("uDel(document.querySelector('#ac1 button:last-child'),ACCS[0].k)");po.wait_for_timeout(200);po.click('#ac1 button:has-text("Confirmer")');po.wait_for_timeout(1500)
    chk('K1 compte supprimé',not [x for x in json.loads(st_(po))['profiles'].values() if x['email']=='agent@obany.ga'])
    # sauvegarde / restauration (Super Admin)
    po.on('dialog',lambda d:d.accept())
    with po.expect_download() as dl:po.evaluate("bkExport()")
    path=dl.value.path();bk=json.loads(open(path,encoding='utf-8').read())
    chk('L1 sauvegarde : dossiers + clients/marque exportés',bk.get('agathe')==1 and any(d['parent']=='chunks' for d in bk['docs']) and any(d['id']=='brand' for d in bk['docs']),[(d['parent'],d['id']) for d in bk['docs']])
    po.evaluate("()=>{const m=JSON.parse(localStorage.getItem('__m'));m.docs={};localStorage.setItem('__m',JSON.stringify(m))}")
    bk['docs'].append({'parent':'audit','id':'x','data':{}});bk['docs'].append({'parent':'config','id':'roles','data':{'a':1}});bk['docs'].append({'parent':'chunks','id':'../x','data':{}})
    open('/tmp/bk_test.json','w',encoding='utf-8').write(json.dumps(bk))
    po.evaluate("view='acc';render()");po.wait_for_timeout(500);po.set_input_files('#m input[type=file]','/tmp/bk_test.json');po.wait_for_timeout(2500)
    d2=json.loads(st_(po))['docs'];ks=sorted(k.replace('\u0000','/') for k in d2)
    chk('L2 restauration : dossiers et marque restaurés, éléments non autorisés ignorés','chunks/c000' in ks and 'config/brand' in ks and 'audit/x' not in ks and 'config/roles' not in ks and not any(k.startswith('chunks/..') for k in ks),ks)
    r=pg.evaluate("""async()=>{const f=new File([JSON.stringify({agathe:1,docs:[{parent:'config',id:'brand',data:{nom:'HACK'}}]})],'x.json');const before=localStorage.getItem('__m');await bkImport({files:[f],value:''});return [resp,before===localStorage.getItem('__m')]}""")
    chk('L3 restauration sans effet pour un utilisateur ordinaire',r==[False,True],r)
    chk('Z aucune erreur JavaScript',not ERR,ERR[:3])
    b.close()
srv.terminate()
print('\nRÉSULTAT APPLICATION : %d/%d'%(sum(R),len(R)))
raise SystemExit(0 if all(R) else 1)
