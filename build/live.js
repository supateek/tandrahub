/* ===== Live mode: data comes from the Tandra server ===== */
const DCOLS=['estates','users','apps','notices','media','inspections','broadcasts','subscribers'];
let READY=false,BASE=null,TOK={client:null,staff:null},SYNCQ=Promise.resolve(),syncTimer=null,pendingRender=false;
const tok=()=>S.ui.mode==='staff'?TOK.staff:TOK.client;
const kid=(c,x)=>c==='subscribers'?String(x.email||'').toLowerCase():x.id;
const snapData=()=>JSON.parse(JSON.stringify({c:Object.fromEntries(DCOLS.map(c=>[c,S[c]||[]])),settings:S.settings,log:S.log||[]}));
function diffSnaps(a,b){const ops=[];for(const c of DCOLS){const am=new Map((a.c[c]||[]).map(x=>[kid(c,x),JSON.stringify(x)])),bm=new Map((b.c[c]||[]).map(x=>[kid(c,x),x]));
    for(const [id,x] of bm){if(!id)continue;const j=JSON.stringify(x);if(am.get(id)!==j)ops.push({c,id,d:x})}for(const id of am.keys())if(!bm.has(id))ops.push({c,id,d:null})}
  const settings=JSON.stringify(a.settings)!==JSON.stringify(b.settings)?b.settings:null;const seen=new Set((a.log||[]).map(l=>l.t+l.x));const log=(b.log||[]).filter(l=>!seen.has(l.t+l.x)).slice(0,30);
  return {ops,settings,log}}
async function api(p,body,method){const h={};const t=tok();if(t)h.authorization='Bearer '+t;let o={method:method||(body?'POST':'GET'),headers:h};
  if(body instanceof Blob){o.body=body;h['content-type']=body.type||'application/octet-stream'}else if(body){o.body=JSON.stringify(body);h['content-type']='application/json'}
  try{const r=await fetch(p,o);const j=await r.json().catch(()=>({}));return Object.assign({status:r.status},j,{ok:r.ok&&j.ok!==false})}catch(e){return {ok:false,status:0,error:'Can’t reach Tandra right now. Check your connection and try again.'}}}
function applyState(st){const ui=S.ui;DCOLS.forEach(c=>S[c]=st[c]||[]);S.settings=Object.assign({staff:{}},st.settings||{});S.log=st.log||[];S.ui=ui;
  if(S.ui.mode==='staff')S.ui.staff=st.role==='staff';else S.ui.me=st.role==='client'?st.me:null;BASE=snapData()}
function busy(){const a=document.activeElement;return !$('#modal').hidden||(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)&&a.type!=='file')||document.querySelector('canvas.pad[data-has]')}
function softRender(){if(busy()){pendingRender=true;return}pendingRender=false;const y=scrollY;NAV='none';render();scrollTo(0,y)}
document.addEventListener('focusout',()=>setTimeout(()=>{if(pendingRender&&!busy())softRender()},50));
async function pull(){const r=await api('/api/state');if(!r.ok)return false;if(!r.auth&&tok()){if(S.ui.mode==='staff')TOK.staff=null;else TOK.client=null;saveLocal()}applyState(r.state);return true}
function syncNow(){SYNCQ=SYNCQ.then(async()=>{if(!BASE)return;const cur=snapData(),d=diffSnaps(BASE,cur);if(!d.ops.length&&!d.settings&&!d.log.length)return;
    const r=await api('/api/sync',d);if(!r.ok){toast(r.error||'Couldn’t save your change. Check your connection.');return}
    const after=snapData(),pend=diffSnaps(cur,after);applyState(r.state);
    if(pend.ops.length){for(const op of pend.ops){const arr=S[op.c]||(S[op.c]=[]),i=arr.findIndex(x=>kid(op.c,x)===op.id);if(op.d===null){if(i>-1)arr.splice(i,1)}else if(i>-1)arr[i]=op.d;else arr.push(op.d)}scheduleSync()}
    softRender()}).catch(e=>console.error(e));return SYNCQ}
function scheduleSync(){clearTimeout(syncTimer);syncTimer=setTimeout(syncNow,300)}
function saveLocal(){try{const ui={...S.ui,hist:[],draft:S.ui.draft&&S.ui.draft.step==='done'?null:S.ui.draft};localStorage.setItem(LS,JSON.stringify({ui,TOK}))}catch(e){}}
save=function(){saveLocal();if(READY)scheduleSync()};
load=function(){let st={};try{st=JSON.parse(localStorage.getItem(LS)||'{}')}catch(e){}TOK=Object.assign({client:null,staff:null},st.TOK||{});
  const sd=seed();S={...sd,estates:[],users:[],apps:[],notices:[],media:[],inspections:[],broadcasts:[],subscribers:[],log:[]};
  S.ui=Object.assign(sd.ui,st.ui||{},{hist:[],staff:false,me:null,sign:{},edit:null,mdraft:null,pedit:null})};
const _render=render;render=function(){if(!READY){$('#bar').innerHTML='';$('#app').innerHTML=`<div class="boot"><span class="logo" role="img" aria-label="Tandra Asset Hub" style="--lh:34px"></span><p class="muted small" id="boot-msg">Loading…</p></div>`;return}_render()};
/* uploads go to the server; signatures stay inline */
const readLocal=readFile;
readFile=function(file,max){return readLocal(file,max).then(async r=>{let blob;
  if(r.data&&/^data:/.test(r.data)){blob=await (await fetch(r.data)).blob()}else blob=file;
  if(blob.size>8*1024*1024){toast('That file is too large. Please use one under 8 MB.');return new Promise(()=>{})}
  const nm=encodeURIComponent(r.name||file.name||'file');const h={'x-file-name':nm};const t=tok();if(t)h.authorization='Bearer '+t;
  toast('Uploading…');let j={};try{const res=await fetch('/api/upload',{method:'POST',headers:Object.assign(h,{'content-type':blob.type||file.type}),body:blob});j=await res.json().catch(()=>({}))}catch(e){}
  if(!j.ok){toast(j.error||'Upload failed. Check your connection and try again.');return new Promise(()=>{})}
  $('#toast').hidden=true;return {name:r.name||file.name,type:j.type,data:j.url}})};
isImg=f=>f&&f.data&&(/^data:image/.test(f.data)||f.data[0]==='@'||(/^\/f\//.test(f.data)&&/^image\//.test(f.type||'')));
/* account actions */
async function signedIn(token){if(S.ui.mode==='staff')TOK.staff=token;else TOK.client=token;saveLocal();await pull()}
Object.assign(T,{
  async login(ev){ev.preventDefault();const r=await api('/api/login',{email:$('#li-email').value.trim(),password:$('#li-pass').value});if(!r.ok){toast(r.error);return}await signedIn(r.token);S.ui.tab='overview';T.c('account')},
  async register(ev){ev.preventDefault();const f=Object.fromEntries(new FormData(ev.target));const r=await api('/api/register',{name:f.name,email:f.email,phone:f.phone,password:f.pass,subscribed:!!f.sub});if(!r.ok){toast(r.error);return}
    await signedIn(r.token);const u=me();if(u){notify(u.id,'Welcome to Tandra Asset Hub',`Dear ${first(u.name)}, your account is ready. Save house types you like and we’ll keep you posted.`,['app']);save()}T.c('account');toast('Account created')},
  async forgot(ev){ev.preventDefault();await api('/api/forgot',{email:$('#fg-email').value.trim()});modal(`<h3>We’ve told our team</h3><p class="small">If that email has an account, a Tandra staff member will call the phone number on it with a temporary password.</p><p class="small muted">Need it sooner? Call ${esc(S.settings.company.phone)}.</p><button class="btn" onclick="T.close();T.c('login')">OK</button>`)},
  async logout(){await api('/api/logout',{});TOK.client=null;saveLocal();await pull();T.c('home')},
  async changePass(ev){ev.preventDefault();const f=Object.fromEntries(new FormData(ev.target));const r=await api('/api/password',{cur:f.cur,np:f.np});if(!r.ok){toast(r.error);return}ev.target.reset();toast('Password updated')},
  async staffLogin(ev){ev.preventDefault();const r=await api('/api/staff/login',{email:$('#st-email').value.trim(),password:$('#st-pass').value});if(!r.ok){toast(r.error);return}await signedIn(r.token);S.ui.sv='dash';render()},
  async staffOut(){await api('/api/logout',{});TOK.staff=null;saveLocal();await pull();render()},
  verify(ev){ev.preventDefault();const c=$('#vcode').value.trim();S.ui.cp={r:c,vres:null};render();api('/api/verify?code='+encodeURIComponent(c)).then(r=>{S.ui.cp={r:c,vres:r.ok?r:{found:false}};render()})},
  resetDemo(){},
});
const _c=T.c;T.c=function(v,p={}){if(v==='type'&&p.t)api('/api/view',{t:p.t});return _c.call(T,v,p)};
const _payModal=T.payModal;T.payModal=function(aid){_payModal(aid);const on=document.querySelector('#modal input[name=method][value=online]');if(on){on.closest('label').remove();const ph=document.querySelector('#modal input[name=method][value=physical]');ph.checked=true;$('#phys').hidden=false;$('#onl').textContent='Online card payments are coming soon.'}};
const _resetFor=T.resetFor;T.resetFor=function(uidd){const keep=toast;let msg='';toast=m=>{msg=m};_resetFor(uidd);toast=keep;const u=U(uidd);const p=(msg.match(/password: (\S+?)\)/)||[])[1]||'';modal(`<h3>Temporary password for ${esc(u.name)}</h3><p class="small">Read this to ${esc(first(u.name))} on ${esc(u.phone||'the phone')}. It replaces their old password.</p><div class="creds" style="font-size:20px;text-align:center">${esc(p)}</div><p class="small muted">They can change it in Profile after signing in.</p><button class="btn" onclick="T.close()">Done</button>`)};
const _submitApp=T.submitApp;T.submitApp=async function(){if(T._sending)return;T._sending=true;try{const d=S.ui.draft,f=d.f;let pass=null;
    if(!me()){pass='tah-'+code(6).toLowerCase();const full=[f.a_first,f.a_other,f.a_surname].filter(Boolean).join(' ');
      const r=await api('/api/register',{name:full,email:f.a_email,phone:f.a_phone,password:pass,address:f.a_same?f.a_contact:(f.a_res||f.a_contact),occupation:f.a_occ,subscribed:true});
      if(!r.ok){toast(r.status===409?'You already have an account with this email. Sign in (Profile tab), then submit again — your answers are saved.':r.error);return}
      TOK.client=r.token;saveLocal();await pull();S.ui.draft=d}
    toast('Sending your application…');_submitApp();const dd=S.ui.draft;dd.newPass=pass;await syncNow();const a=A(dd.aid);
    if(!a||!/^TAH\//.test(a.ref)){toast('Your application didn’t reach us. Check your connection and press Submit again.');S.ui.draft=d;d.step=5;render();return}
    dd.ref=a.ref;saveLocal();render()}finally{T._sending=false}};
async function boot(){load();const route=()=>{const m=location.hash==='#staff'?'staff':'client';const ch=S.ui.mode!==m;S.ui.mode=m;if(ch){S.ui.hist=[];pull().then(()=>render())}else render()};
  addEventListener('hashchange',route);S.ui.mode=location.hash==='#staff'?'staff':'client';render();
  for(let i=0;!(await pull());i++){const el=$('#boot-msg');if(el)el.textContent=i?'Still connecting… the server may be waking up.':'Connecting…';await new Promise(r=>setTimeout(r,2500))}
  READY=true;render();
  setInterval(()=>{if(document.hidden||T._sending)return;const d=BASE&&diffSnaps(BASE,snapData());if(d&&(d.ops.length||d.settings||d.log.length))syncNow();else pull().then(ok=>ok&&softRender())},S.ui.mode==='staff'?30000:60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&READY)pull().then(ok=>ok&&softRender())})}
