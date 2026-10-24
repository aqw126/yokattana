const KEY='watashi-no-hondana-v1',OWNER_KEY='watashi-no-hondana-owner',$=s=>document.querySelector(s);
const cloud=window.supabase?.createClient(window.SUPABASE_CONFIG?.url,window.SUPABASE_CONFIG?.publishableKey);
let currentUser=null;

function setSyncStatus(message,connected=false) {
  const status=$('#sync-status');
  status.textContent=message;
  status.classList.toggle('connected',connected)
}
async function syncItem(item) {
  if(!currentUser) return true;
  const { error }=await cloud.from('library_items').upsert({ id:item.id,user_id:currentUser.id,payload:item,updated_at:item.updatedAt });
  if(error) { setSyncStatus('同期に失敗しました'); return false; }
  setSyncStatus('自動同期中',true);
  return true
}
function isNewer(a,b) {
  return new Date(a.updatedAt)>new Date(b.updatedAt)
}
async function loadCloudItems() {
  const { data,error }=await cloud.from('library_items').select('payload');
  if(error) { setSyncStatus('同期に失敗しました'); return; }
  const remote=new Map();
  data.forEach(row=> { const item=normalizeItem(row.payload); if(item) remote.set(item.id,item); });
  const merged=new Map(state.items.map(item=>[item.id,item]));
  remote.forEach((item,id)=> { const local=merged.get(id); if(!local||isNewer(item,local)) merged.set(id,item); });
  state.items=[...merged.values()];
  save();
  await Promise.all(state.items.filter(item=> { const r=remote.get(item.id); return !r||isNewer(item,r); }).map(syncItem));
  render()
}
function accountIdentifier(accountName) {
  const normalized=accountName.trim().toLocaleLowerCase('ja');
  if(normalized.length<2) throw new Error('アカウント名は2文字以上にしてください。');
  const bytes=new TextEncoder().encode(normalized);
  const encoded=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  return `user-${encoded}@users.yokattana.invalid`
}
function setAuthMessage(message='') {
  $('#auth-message').textContent=message
}
async function finishLogin(user) {
  currentUser=user;
  $('#auth-dialog').close();
  $('#auth-button').textContent='ログアウト';
  // 別アカウントのローカルデータを、ログインしたアカウントへ混ぜない
  if(localStorage.getItem(OWNER_KEY)!==user.id) {
    if(localStorage.getItem(OWNER_KEY)) { state.items=[]; save(); }
    localStorage.setItem(OWNER_KEY,user.id)
  }
  await loadCloudItems()
}
async function initializeCloud() {
  if(!cloud) { setSyncStatus('同期設定が見つかりません'); return; }
  const { data }=await cloud.auth.getSession();
  currentUser=data.session?.user||null;
  if(currentUser) await finishLogin(currentUser);
  else setSyncStatus('ログインすると自動同期')
}
async function toggleAuthentication() {
  if(currentUser) {
    const results=await Promise.all(state.items.map(syncItem));
    if(results.includes(false)&&!confirm('同期できていない記録があります。ログアウトするとこの端末から消えます。続けますか？')) return;
    await cloud.auth.signOut();
    currentUser=null;
    state.items=[];
    save();
    localStorage.removeItem(OWNER_KEY);
    render();
    $('#auth-button').textContent='ログイン';
    setSyncStatus('ログインすると自動同期');
    return
  }
  $('#auth-form').reset();
  setAuthMessage();
  $('#auth-dialog').showModal();
  $('#account-name').focus()
}
async function signInWithAccount(event) {
  event.preventDefault();
  let identifier;
  try { identifier=accountIdentifier($('#account-name').value); }
  catch(error) { setAuthMessage(error.message); return; }
  const { data,error }=await cloud.auth.signInWithPassword({ email:identifier,password:$('#account-password').value });
  if(error) { setAuthMessage('アカウント名またはパスワードが違います。'); return; }
  await finishLogin(data.user)
}
async function signUpWithAccount() {
  let identifier;
  try { identifier=accountIdentifier($('#account-name').value); }
  catch(error) { setAuthMessage(error.message); return; }
  const password=$('#account-password').value;
  if(password.length<8) { setAuthMessage('パスワードは8文字以上にしてください。'); return; }
  setAuthMessage('アカウントを作成しています…');
  const { data,error }=await cloud.auth.signUp({ email:identifier,password,options:{ data:{ display_name:$('#account-name').value.trim() } } });
  if(error) { setAuthMessage(error.message); return; }
  if(!data.session) { setAuthMessage('Supabaseでメール確認が有効です。Authenticationのメール確認をオフにしてください。'); return; }
  await finishLogin(data.user)
}

const state= {
  items:load(),cover:null,formTags:[]
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COVER=/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
function validDate(v,fallback) {
  const t=new Date(v);
  return typeof v==='string'&&!isNaN(t)?t.toISOString():fallback
}
function normalizeItem(raw) {
  if(!raw||typeof raw!=='object') return null;
  const deleted=raw.deleted===true,title=String(raw.title??'').trim();
  if(!deleted&&!title) return null;
  const createdAt=validDate(raw.createdAt,new Date().toISOString());
  return {
    id:typeof raw.id==='string'&&UUID.test(raw.id)?raw.id:crypto.randomUUID(),
    title,genre:String(raw.genre??'').trim()||'未分類',
    rating:Math.min(5,Math.max(3,Number(raw.rating)||3)),
    tags:Array.isArray(raw.tags)?[...new Set(raw.tags.map(t=>String(t).trim()).filter(Boolean))]:[],
    notes:String(raw.notes??'').trim(),
    cover:typeof raw.cover==='string'&&COVER.test(raw.cover)?raw.cover:null,
    createdAt,updatedAt:validDate(raw.updatedAt,createdAt),deleted
  }
}
function load() {
  try {
    const list=JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(list)?list.map(normalizeItem).filter(Boolean):[]
  }
  catch {
    return[]
  }
}
function save() {
  try {
    localStorage.setItem(KEY,JSON.stringify(state.items));
    return true
  }
  catch {
    return false
  }
}
function liveItems() {
  return state.items.filter(x=>!x.deleted)
}
function readCover(file) {
  return new Promise((resolve,reject)=> {
    if(!file.type.startsWith('image/')) return reject(new Error('画像ファイルを選んでください。'));
    const url=URL.createObjectURL(file),img=new Image();
    img.onload=()=> {
      const scale=Math.min(1,600/Math.max(img.width,img.height)),c=document.createElement('canvas'),g=c.getContext('2d');
      c.width=Math.max(1,Math.round(img.width*scale));
      c.height=Math.max(1,Math.round(img.height*scale));
      g.fillStyle='#fff';
      g.fillRect(0,0,c.width,c.height);
      g.drawImage(img,0,0,c.width,c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg',0.8))
    };
    img.onerror=()=> { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした。')); };
    img.src=url
  })
}
function e(v='') {
  return String(v).replace(/[&<>'"]/g,c=>( {
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }
  [c]))
}
function genres() {
  return[...new Set(liveItems().map(x=>x.genre))].sort((a,b)=>a.localeCompare(b,'ja'))
}
function alltags() {
  return[...new Set(liveItems().flatMap(x=>x.tags))].sort((a,b)=>a.localeCompare(b,'ja'))
}
function choices(el,values) {
  let old=el.value,label=el.options[0].text;
  el.innerHTML=`<option value="">${label}</option>`+values.map(x=>`<option value="${e(x)}">${e(x)}</option>`).join('');
  el.value=values.includes(old)?old:''
}
function date(v) {
  return new Intl.DateTimeFormat('ja-JP', {
    year:'numeric',month:'numeric',day:'numeric'
  }).format(new Date(v))
}
function visible() {
  let q=$('#query').value.trim().toLocaleLowerCase('ja'),g=$('#genre').value,t=$('#tag').value,s=$('#sort').value,r=liveItems().filter(x=> {
    let text=[x.title,x.genre,...x.tags,x.notes||''].join(' ').toLocaleLowerCase('ja');
    return(!q||text.includes(q))&&(!g||x.genre===g)&&(!t||x.tags.includes(t))
  });
  return r.sort((a,b)=>s==='old'?new Date(a.createdAt)-new Date(b.createdAt):s==='high'?b.rating-a.rating||new Date(b.createdAt)-new Date(a.createdAt):s==='low'?a.rating-b.rating||new Date(b.createdAt)-new Date(a.createdAt):s==='title'?a.title.localeCompare(b.title,'ja'):new Date(b.createdAt)-new Date(a.createdAt))
}
function render() {
  choices($('#genre'),genres());
  choices($('#tag'),alltags());
  $('#genreList').innerHTML=genres().map(x=>`<option value="${e(x)}">`).join('');
  const live=liveItems();
  $('#count').textContent=live.length;
  $('#genres').textContent=genres().length;
  $('#average').textContent=live.length?(live.reduce((a,x)=>a+Number(x.rating),0)/live.length).toFixed(1):'—';
  let list=visible(),grid=$('#grid');
  grid.innerHTML='';
  $('#empty').hidden=live.length>0;
  $('#notfound').hidden=live.length===0||list.length>0;
  $('#heading').textContent=$('#query').value||$('#genre').value||$('#tag').value?`検索結果 (${list.length})`:`すべての記録 (${live.length})`;
  let tpl=$('#card');
  list.forEach(x=> {
    let n=tpl.content.cloneNode(true),img=n.querySelector('img'),letter=n.querySelector('.art span');
    if(x.cover) {
      img.src=x.cover;
      img.alt=x.title+'の表紙';
      img.hidden=false;
      letter.hidden=true
    }
    else letter.textContent=[...x.title.trim()][0]||'？';
    n.querySelector('.meta b').textContent=x.genre;
    n.querySelector('.meta strong').textContent='★ '+Number(x.rating).toFixed(1);
    n.querySelector('h3').textContent=x.title;
    n.querySelector('.tags').innerHTML=x.tags.slice(0,4).map(t=>`<span>${e(t)}</span>`).join('');
    let p=n.querySelector('.cardbody p');
    p.textContent=x.notes||'';
    p.hidden=!x.notes;
    n.querySelector('footer small').textContent=date(x.createdAt)+' に追加';
    n.querySelector('.open').onclick=()=>open(x);
    n.querySelector('.edit').onclick=()=>open(x);
    grid.append(n)
  })
}
function preview(v) {
  const box=$('#preview');
  box.textContent='表紙画像';
  if(v) {
    const img=document.createElement('img');
    img.src=v;
    img.alt='選択した表紙';
    box.textContent='';
    box.append(img)
  }
  $('#removeCover').hidden=!v
}
function renderFormTags() {
  const container=$('#tag-chips');
  container.innerHTML='';
  state.formTags.forEach((tag,index)=> {
    const chip=document.createElement('button');
    chip.type='button';
    chip.className='tag-chip';
    chip.textContent=`${tag} ×`;
    chip.setAttribute('aria-label',`${tag} を削除`);
    chip.onclick=()=> {
      state.formTags=state.formTags.filter((_,tagIndex)=>tagIndex!==index);
      renderFormTags()
    };
    container.append(chip)
  })
}
function addFormTag() {
  const input=$('#tag-input');
  const tag=input.value.trim();
  if(!tag||state.formTags.includes(tag)) return;
  state.formTags.push(tag);
  input.value='';
  renderFormTags()
}
function reset() {
  $('#form').reset();
  $('#id').value='';
  state.cover=null;
  state.formTags=[];
  renderFormTags();
  $('#ratingValue').textContent='—';
  preview(null)
}
function open(x) {
  reset();
  $('#kicker').textContent=x?'EDIT ENTRY':'NEW ENTRY';
  $('#modalTitle').textContent=x?'記録を編集':'記録を追加';
  $('#delete').hidden=!x;
  if(x) {
    $('#id').value=x.id;
    $('#title').value=x.title;
    $('#entryGenre').value=x.genre;
    $('#rating').value=x.rating;
    $('#ratingValue').textContent=Number(x.rating).toFixed(1);
    state.formTags=[...(x.tags||[])];
    renderFormTags();
    $('#notes').value=x.notes||'';
    state.cover=x.cover||null;
    preview(state.cover)
  }
  $('#dialog').showModal();
  $('#title').focus()
}
function close() {
  $('#dialog').close()
}
function commit(items) {
  const previous=state.items;
  state.items=items;
  if(save()) return true;
  state.items=previous;
  alert('保存できませんでした。ブラウザの保存容量が足りない可能性があります。バックアップを書き出して、不要な記録や画像を減らしてください。');
  return false
}
function backup() {
  let u=URL.createObjectURL(new Blob([JSON.stringify( {
    version:1,exportedAt:new Date().toISOString(),items:state.items
  },null,2)], {
    type:'application/json'
  })),a=document.createElement('a');
  a.href=u;
  a.download=`watashi-no-hondana-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(u)
}
$('#auth-button').onclick=toggleAuthentication;
$('#auth-form').onsubmit=signInWithAccount;
$('#signup-button').onclick=signUpWithAccount;
$('#close-auth').onclick=()=>$('#auth-dialog').close();
$('#add').onclick=()=>open();
$('#emptyAdd').onclick=()=>open();
$('#close').onclick=close;
$('#cancel').onclick=close;
$('#rating').oninput=x=>$('#ratingValue').textContent=Number(x.target.value).toFixed(1);
$('#add-tag').onclick=addFormTag;
$('#tag-input').addEventListener('keydown', event=> {
  if(event.key==='Enter') {
    event.preventDefault();
    addFormTag()
  }
});
$('#cover').onchange=async x=> {
  const f=x.target.files[0];
  if(!f) return;
  try {
    state.cover=await readCover(f);
    preview(state.cover)
  }
  catch(error) {
    alert(error.message);
    x.target.value=''
  }
};
$('#removeCover').onclick=()=> {
  state.cover=null;
  $('#cover').value='';
  preview(null)
};
$('#form').onsubmit=x=> {
  x.preventDefault();
  let id=$('#id').value,old=state.items.find(x=>x.id===id),entry= {
    id:id||crypto.randomUUID(),title:$('#title').value.trim(),genre:$('#entryGenre').value.trim(),rating:Number($('#rating').value),tags:[...state.formTags],notes:$('#notes').value.trim(),cover:state.cover,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),deleted:false
  };
  if(!commit(old?state.items.map(x=>x.id===id?entry:x):[...state.items,entry])) return;
  syncItem(entry);
  close();
  render()
};
$('#delete').onclick=()=> {
  let id=$('#id').value,old=state.items.find(x=>x.id===id);
  if(old&&confirm('この記録を削除しますか？')) {
    // 他の端末へ削除を伝えるため、中身を消した墓標として残す
    const tombstone= { ...old,title:'',notes:'',cover:null,tags:[],deleted:true,updatedAt:new Date().toISOString() };
    if(!commit(state.items.map(x=>x.id===id?tombstone:x))) return;
    syncItem(tombstone);
    close();
    render()
  }
};
['#query','#genre','#tag','#sort'].forEach(s=>$(s).addEventListener(s==='#query'?'input':'change',render));
$('#export').onclick=backup;
$('#import').onclick=()=>$('#file').click();
$('#file').onchange=x=> {
  let f=x.target.files[0];
  if(!f)return;
  let r=new FileReader;
  r.onload=()=> {
    try {
      let o=JSON.parse(r.result),a=Array.isArray(o)?o:o.items;
      if(!Array.isArray(a))throw 0;
      const imported=a.map(normalizeItem).filter(Boolean);
      if(!imported.length&&a.length)throw 0;
      if(confirm(`${imported.length}件のデータで現在の記録を置き換えます。よろしいですか？`)) {
        const now=new Date().toISOString(),ids=new Set(imported.map(x=>x.id));
        // 読み込みに含まれない既存の記録は削除扱いにして、クラウドからも消す
        const removed=state.items.filter(x=>!x.deleted&&!ids.has(x.id)).map(x=>( { ...x,title:'',notes:'',cover:null,tags:[],deleted:true,updatedAt:now } ));
        const kept=state.items.filter(x=>x.deleted&&!ids.has(x.id));
        const next=imported.map(x=>( { ...x,updatedAt:now } ));
        if(!commit([...kept,...removed,...next])) return;
        Promise.all([...removed,...next].map(syncItem));
        render()
      }
    }
    catch {
      alert('読み込めませんでした。バックアップJSONを選択してください。')
    }
  };
  r.readAsText(f);
  x.target.value=''
};
render();
initializeCloud();


