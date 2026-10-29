/* Simulation du client Supabase pour tester l'application dans un navigateur sans compte Supabase.
   Reproduit les règles de supabase/schema.sql (testées séparément sur PostgreSQL). */
(function(){
const K='__m',L=()=>{const m=JSON.parse(localStorage.getItem(K)||'{"docs":{},"profiles":{},"users":{},"files":{}}');m.sess=sessionStorage.getItem('__s');return m},S=o=>{if(o.sess)sessionStorage.setItem('__s',o.sess);else sessionStorage.removeItem('__s');const c={...o};delete c.sess;localStorage.setItem(K,JSON.stringify(c))};
const uid=()=>L().sess,prof=()=>{const m=L();return m.sess?m.profiles[m.sess]:null};
const act=()=>{const p=prof();return !!(p&&p.actif)},owner=()=>{const p=prof();return !!(p&&p.actif&&p.role=='owner')},hp=k=>{const p=prof();return !!(p&&p.actif&&(p.role=='owner'||(p.perms||{})[k]===true))};
function canRead(par,id){if(!uid())return par=='config'&&id=='brand';if(owner())return true;if(!act())return false;return !(par=='audit'||par=='logins')}
function canWrite(par,id){if(owner())return true;if(!act())return false;if(['audit','logins','users'].includes(par))return true;
if(par=='chunks')return ['create','edit','billw','annul','del','import'].some(hp);if(par=='config'&&id=='clients')return hp('clients')||hp('cdel');if(par.startsWith('fdocs/'))return ['dadd','ddel','docs','billw'].some(hp);return false}
const ls=[];const fire=(pl)=>ls.slice().forEach(l=>{try{l(pl||{})}catch(e){}});window.addEventListener('storage',()=>fire({}));
function builder(table){const q={t:table,f:[],op:'select',single:false,ord:null,lim:null,pay:null,ret:false};
const api={select(c){if(q.op=='delete'||q.op=='upsert')q.ret=true;else q.op='select';return api},eq(c,v){q.f.push([c,v]);return api},order(c,o){q.ord=[c,o.ascending];return api},limit(n){q.lim=n;return api},range(a,b){q.lim=b-a+1;return api},maybeSingle(){q.single=true;return api},
upsert(p){q.op='upsert';q.pay=p;return api},delete(){q.op='delete';return api},
then(res,rej){return Promise.resolve().then(()=>run(q)).then(res,rej)}};return api}
function run(q){const m=L();const err=(msg,code)=>({data:null,error:{message:msg,code:code||'42501'}});
if(q.t=='profiles'){if(q.op!='select')return err('permission denied');let rows=Object.values(m.profiles).filter(p=>uid()&&(owner()||p.id==uid()));q.f.forEach(([c,v])=>rows=rows.filter(r=>r[c]==v));return q.single?{data:rows[0]||null,error:null}:{data:rows,error:null}}
const key=(p,i)=>p+'\u0000'+i;let rows=Object.entries(m.docs).map(([k,v])=>({parent:v.parent,id:v.id,data:v.data}));q.f.forEach(([c,v])=>rows=rows.filter(r=>r[c]==v));
if(q.op=='select'){rows=rows.filter(r=>canRead(r.parent,r.id));if(q.ord){const [c,asc]=q.ord,g=r=>c.startsWith('data->>')?String((r.data||{})[c.slice(7)]||''):r[c];rows.sort((a,b)=>g(a)<g(b)?-1:g(a)>g(b)?1:0);if(!asc)rows.reverse()}if(q.lim)rows=rows.slice(0,q.lim);return q.single?{data:rows[0]||null,error:null}:{data:rows,error:null}}
if(q.op=='upsert'){const p=q.pay;if(!canWrite(p.parent,p.id))return err('new row violates row-level security policy for table "docs"');m.docs[key(p.parent,p.id)]={parent:p.parent,id:p.id,data:p.data};S(m);fire({eventType:'UPDATE',new:{parent:p.parent,id:p.id,data:p.data},old:{}});return{data:null,error:null}}
if(q.op=='delete'){const del=rows.filter(r=>canWrite(r.parent,r.id)&&!((r.parent=='audit'||r.parent=='logins')&&!owner()));del.forEach(r=>delete m.docs[key(r.parent,r.id)]);S(m);del.forEach(r=>fire({eventType:'DELETE',new:{},old:{parent:r.parent,id:r.id}}));return{data:q.ret?del.map(r=>({id:r.id})):null,error:null}}}
const auth={async signInWithPassword({email,password}){const m=L(),u=Object.values(m.users).find(x=>x.email==email&&x.pw==password&&!x.banned);if(!u)return{data:{user:null,session:null},error:{message:'Invalid login credentials'}};m.sess=u.id;S(m);return{data:{user:{id:u.id,email},session:{access_token:'tok_'+u.id,user:{id:u.id}}},error:null}},
async getSession(){const m=L();return{data:{session:m.sess?{access_token:'tok_'+m.sess,user:{id:m.sess,email:(m.users[m.sess]||{}).email}}:null}}},
onAuthStateChange(cb){window.__authcb=cb;return{data:{subscription:{unsubscribe(){}}}}},
async signOut(){const m=L();m.sess=null;S(m);window.__authcb&&window.__authcb('SIGNED_OUT');return{error:null}},
async updateUser({password}){const m=L();if(!m.sess)return{error:{message:'not logged'}};m.users[m.sess].pw=password;S(m);return{data:{},error:null}},
async resetPasswordForEmail(e){window.__resetMail=e;return{data:{},error:null}}};
let n=0;const sb={auth,from:builder,async rpc(f){if(f=='touch_login'){const m=L();if(m.sess){m.profiles[m.sess].last_login=new Date().toISOString();S(m)}}return{data:null,error:null}},
channel(){const c={fns:[],on(t,o,fn){c.fns.push(fn);return c},subscribe(cb){const l=(pl)=>c.fns.forEach(f=>f(pl));c.l=l;ls.push(l);setTimeout(()=>cb&&cb('SUBSCRIBED'),0);return c}};return c},removeChannel(c){const i=ls.indexOf(c.l);if(i>=0)ls.splice(i,1)},
storage:{from(){return{async upload(id,blob){if(!(hp('dadd')||hp('docs')||hp('billw')))return{error:{message:'new row violates row-level security policy',code:'42501'}};const m=L();m.files[id]=await blob.text();S(m);return{data:{},error:null}},async download(id){const m=L();if(!act()||!(id in m.files))return{data:null,error:{message:'not found'}};return{data:new Blob([m.files[id]]),error:null}},async remove(ids){const m=L();ids.forEach(i=>delete m.files[i]);S(m);return{error:null}}}}}};
window.supabase={createClient:()=>sb};
// faux serveur /api/users (mêmes contrôles que api/users.js, testé séparément)
const _f=window.fetch.bind(window);window.fetch=async(u,o)=>{if(String(u)=='/api/users'){const tok=((o.headers||{}).Authorization||'').replace('Bearer ','');const m=L(),uid0=tok.replace('tok_',''),p=m.profiles[uid0];const R=(c,b)=>new Response(JSON.stringify(b),{status:c});
if(!p||p.role!='owner'||!p.actif)return R(403,{error:'Réservé au Super Administrateur'});const b=JSON.parse(o.body),pw=x=>typeof x=='string'&&x.length>=10&&/[A-Za-z]/.test(x)&&/\d/.test(x);
if(b.action=='create'){if(Object.values(m.users).some(x=>x.email==b.email))return R(400,{error:'Un compte existe déjà avec cette adresse e-mail'});if(!pw(b.password))return R(400,{error:'Le mot de passe doit contenir au moins 10 caractères, avec des lettres et des chiffres'});const id='u'+Math.random().toString(36).slice(2,10);m.users[id]={id,email:b.email,pw:b.password};m.profiles[id]={id,email:b.email,nom:b.nom,fonction:b.fonction,tel:b.tel,role:'user',perms:b.perms,actif:true};S(m);fire({});return R(200,{ok:true,id})}
const t=m.profiles[b.id];if(!t||t.role=='owner')return R(404,{error:'introuvable'});
if(b.action=='update'){['nom','fonction','tel','perms','actif'].forEach(k=>{if(k in b)t[k]=b[k]});if('actif' in b)m.users[b.id].banned=!b.actif;S(m);fire({});return R(200,{ok:true})}
if(b.action=='setpw'){if(!pw(b.password))return R(400,{error:'mot de passe faible'});m.users[b.id].pw=b.password;S(m);return R(200,{ok:true})}
if(b.action=='delete'){delete m.profiles[b.id];delete m.users[b.id];S(m);fire({});return R(200,{ok:true})}return R(400,{error:'?'})}return _f(u,o)};
})();
