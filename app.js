const KEY='yokattana-v1',OWNER_KEY='yokattana-owner',PENDING_KEY='yokattana-pending',$=s=>document.querySelector(s);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COVER=/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const TOMBSTONE_DAYS=90,SYNC_CHUNK=20,PAGE_SIZE=100,COVER_LIMIT=150000;
const cloud=window.supabase?.createClient(window.SUPABASE_CONFIG?.url,window.SUPABASE_CONFIG?.publishableKey);
let currentUser=null,flushing=false,shrinking=false,dirty=false;

// 旧名称で保存されたデータを引き継ぐ
try {
  [['watashi-no-hondana-v1',KEY],['watashi-no-hondana-owner',OWNER_KEY]].forEach(([from,to])=> {
    const value=localStorage.getItem(from);
    if(value===null) return;
    if(localStorage.getItem(to)===null) localStorage.setItem(to,value);
    localStorage.removeItem(from)
  })
}
catch {}

const pending=new Set((()=> {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY))||[]; }
  catch { return[]; }
})());
function savePending() {
  try { localStorage.setItem(PENDING_KEY,JSON.stringify([...pending])); }
  catch {}
}
let toastTimer;
function showToast(message) {
  const toast=$('#toast');
  toast.textContent=message;
  toast.hidden=false;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=> { toast.hidden=true; },5000)
}
function updateSyncStatus(failed=false) {
  const status=$('#sync-status');
  let message='この端末に保存中',connected=false;
  if(!cloud) message='同期設定が見つかりません';
  else if(!currentUser) message='ログインすると自動同期';
  else if(failed||pending.size) message=pending.size?`同期待ち ${pending.size}件`:'同期に失敗しました';
  else { message='自動同期中'; connected=true; }
  status.textContent=message;
  status.classList.toggle('connected',connected)
}
function isNewer(a,b) {
  return new Date(a.updatedAt)>new Date(b.updatedAt)
}
function mergeItems(local,incoming) {
  const merged=new Map(local.map(item=>[item.id,item]));
  incoming.forEach(item=> { const current=merged.get(item.id); if(!current||isNewer(item,current)) merged.set(item.id,item); });
  return[...merged.values()]
}
async function syncItems(items) {
  if(!currentUser||!items.length) return true;
  let ok=true;
  for(let i=0;i<items.length;i+=SYNC_CHUNK) {
    const chunk=items.slice(i,i+SYNC_CHUNK);
    try {
      const { error }=await cloud.from('library_items').upsert(chunk.map(item=>( { id:item.id,user_id:currentUser.id,payload:item,updated_at:item.updatedAt } )));
      if(error) throw error;
      chunk.forEach(item=> {
        // 送信中にさらに編集された記録は、同期待ちのままにする
        if(state.items.find(x=>x.id===item.id)?.updatedAt===item.updatedAt) pending.delete(item.id)
      })
    }
    catch {
      chunk.forEach(item=>pending.add(item.id));
      ok=false
    }
  }
  savePending();
  updateSyncStatus();
  return ok
}
function syncItem(item) {
  return syncItems([item])
}
function markPending(items) {
  if(!currentUser) return;
  items.forEach(x=>pending.add(x.id));
  savePending()
}
async function flushPending() {
  if(!currentUser||flushing) return true;
  const ids=new Set(state.items.map(x=>x.id));
  [...pending].filter(id=>!ids.has(id)).forEach(id=>pending.delete(id));
  if(!pending.size) { savePending(); updateSyncStatus(); return true; }
  flushing=true;
  try { return await syncItems(state.items.filter(x=>pending.has(x.id))); }
  finally { flushing=false; }
}
async function fetchRemoteItems() {
  const rows=[];
  for(let from=0;;from+=PAGE_SIZE) {
    const { data,error }=await cloud.from('library_items').select('payload').order('id').range(from,from+PAGE_SIZE-1);
    if(error) throw error;
    rows.push(...data);
    if(data.length<PAGE_SIZE) return rows
  }
}
async function loadCloudItems() {
  let rows;
  try { rows=await fetchRemoteItems(); }
  catch { updateSyncStatus(true); return; }
  const remote=new Map();
  rows.forEach(row=> { const item=normalizeItem(row.payload); if(item) remote.set(item.id,item); });
  const cutoff=Date.now()-TOMBSTONE_DAYS*86400000;
  const merged=mergeItems(state.items,[...remote.values()]);
  // 十分古い削除記録は、端末とクラウドの両方から片付ける
  const expired=merged.filter(x=>x.deleted&&new Date(x.updatedAt)<cutoff);
  state.items=merged.filter(x=>!expired.includes(x));
  save();
  if(expired.length) {
    try { await cloud.from('library_items').delete().in('id',expired.map(x=>x.id)); }
    catch {}
  }
  await syncItems(state.items.filter(item=> { const r=remote.get(item.id); return !r||isNewer(item,r); }));
  render();
  shrinkExistingCovers()
}
function setAuthMessage(message='') {
  $('#auth-message').textContent=message
}
async function finishLogin(user) {
  currentUser=user;
  if($('#auth-dialog').open) $('#auth-dialog').close();
  $('#auth-button').textContent='ログアウト';
  // 別アカウントのローカルデータを、ログインしたアカウントへ混ぜない
  if(localStorage.getItem(OWNER_KEY)!==user.id) {
    if(localStorage.getItem(OWNER_KEY)) { state.items=[]; pending.clear(); savePending(); save(); }
    localStorage.setItem(OWNER_KEY,user.id)
  }
  // ログイン直後は、クラウドとの差分をまとめて送るので、以前の同期待ちは破棄する
  pending.clear();
  savePending();
  updateSyncStatus();
  await loadCloudItems()
}
function applySignedOut() {
  currentUser=null;
  state.items=[];
  pending.clear();
  savePending();
  save();
  localStorage.removeItem(OWNER_KEY);
  $('#auth-button').textContent='ログイン';
  updateSyncStatus();
  render()
}
async function initializeCloud() {
  updateSyncStatus();
  if(!cloud) return;
  // 別のタブでのログアウトや、期限切れによるログアウトも反映する
  cloud.auth.onAuthStateChange(event=> { if(event==='SIGNED_OUT'&&currentUser) applySignedOut(); });
  try {
    const { data }=await cloud.auth.getSession();
    if(data.session?.user) await finishLogin(data.session.user);
    else { pending.clear(); savePending(); }
  }
  catch { updateSyncStatus(true); }
}
async function toggleAuthentication() {
  if(!cloud) { alert('同期の設定が見つかりません。'); return; }
  if(currentUser) {
    await flushPending();
    if(pending.size&&!confirm('同期できていない記録があります。ログアウトするとこの端末から消えます。続けますか？')) return;
    try { await cloud.auth.signOut(); }
    catch {}
    if(currentUser) applySignedOut();
    showToast('ログアウトしました。この端末の記録は消去しました。ログインすると、同期した記録が再び読み込まれます。');
    return
  }
  setAuthMessage();
  $('#auth-dialog').showModal()
}
async function signInWithGoogle() {
  setAuthMessage('Googleのログイン画面に移動します…');
  try {
    const { error }=await cloud.auth.signInWithOAuth({ provider:'google',options:{ redirectTo:location.origin+location.pathname } });
    if(error) throw error
  }
  catch { setAuthMessage('ログインを開始できませんでした。通信状況を確認して、もう一度お試しください。'); }
}

const state= {
  items:load(),cover:null,formTags:[]
};
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
function scaleImage(src) {
  return new Promise((resolve,reject)=> {
    const img=new Image();
    img.onload=()=> {
      const scale=Math.min(1,600/Math.max(img.width,img.height)),c=document.createElement('canvas'),g=c.getContext('2d');
      c.width=Math.max(1,Math.round(img.width*scale));
      c.height=Math.max(1,Math.round(img.height*scale));
      g.fillStyle='#fff';
      g.fillRect(0,0,c.width,c.height);
      g.drawImage(img,0,0,c.width,c.height);
      resolve(c.toDataURL('image/jpeg',0.8))
    };
    img.onerror=()=>reject(new Error('画像を読み込めませんでした。'));
    img.src=src
  })
}
async function readCover(file) {
  if(!file.type.startsWith('image/')) throw new Error('画像ファイルを選んでください。');
  const url=URL.createObjectURL(file);
  try { return await scaleImage(url); }
  finally { URL.revokeObjectURL(url); }
}
// 以前の大きな表紙画像を縮小して、保存容量と同期量を減らす
async function shrinkExistingCovers() {
  if(shrinking) return;
  shrinking=true;
  try {
    const changed=[];
    for(const item of state.items.filter(x=>x.cover&&x.cover.length>COVER_LIMIT)) {
      try {
        const small=await scaleImage(item.cover);
        if(small.length<item.cover.length) changed.push( { ...item,cover:small,updatedAt:new Date().toISOString() } );
      }
      catch {}
    }
    if(!changed.length) return;
    const byId=new Map(changed.map(x=>[x.id,x]));
    if(!commit(state.items.map(x=>byId.get(x.id)||x),true)) return;
    markPending(changed);
    render();
    await flushPending()
  }
  finally { shrinking=false; }
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
const filters= { genre:new Set(),tag:new Set() },filterKeys= {};
// 選択肢が多いときのために、入力した文字で一覧を絞る
function applyOptionSearch(root) {
  const q=root.querySelector('.multi-search').value.trim().toLocaleLowerCase('ja');
  root.querySelectorAll('.multi-panel label').forEach(label=> { label.hidden=!!q&&!label.textContent.toLocaleLowerCase('ja').includes(q); });
}
// 複数選択のフィルター。選択肢が変わったときだけ作り直す（操作中のフォーカスを保つ）
function renderFilter(kind,values) {
  const root=$(`#${kind}-filter`),panel=root.querySelector('.multi-panel'),selected=filters[kind],key=values.join(' ');
  [...selected].filter(v=>!values.includes(v)).forEach(v=>selected.delete(v));
  if(filterKeys[kind]!==key) {
    filterKeys[kind]=key;
    panel.innerHTML='';
    values.forEach(v=> {
      const label=document.createElement('label'),box=document.createElement('input');
      box.type='checkbox';
      box.value=v;
      box.onchange=()=> {
        if(box.checked) selected.add(v);
        else selected.delete(v);
        render()
      };
      label.append(box,document.createTextNode(v));
      panel.append(label)
    })
  }
  panel.querySelectorAll('input').forEach(box=> { box.checked=selected.has(box.value); });
  applyOptionSearch(root);
  root.querySelector('.multi-value').textContent=selected.size?[...selected].join('、'):'すべて'
}
function date(v) {
  return new Intl.DateTimeFormat('ja-JP', {
    year:'numeric',month:'numeric',day:'numeric'
  }).format(new Date(v))
}
function visible() {
  let q=$('#query').value.trim().toLocaleLowerCase('ja'),g=filters.genre,t=filters.tag,s=$('#sort').value,r=liveItems().filter(x=> {
    let text=[x.title,x.genre,...x.tags,x.notes||''].join(' ').toLocaleLowerCase('ja');
    return(!q||text.includes(q))&&(!g.size||g.has(x.genre))&&[...t].every(tag=>x.tags.includes(tag))
  });
  return r.sort((a,b)=>s==='old'?new Date(a.createdAt)-new Date(b.createdAt):s==='high'?b.rating-a.rating||new Date(b.createdAt)-new Date(a.createdAt):s==='low'?a.rating-b.rating||new Date(b.createdAt)-new Date(a.createdAt):s==='title'?a.title.localeCompare(b.title,'ja'):new Date(b.createdAt)-new Date(a.createdAt))
}
function render() {
  renderFilter('genre',genres());
  renderFilter('tag',alltags());
  renderGenreChips();
  const live=liveItems();
  $('#count').textContent=live.length;
  $('#genres').textContent=genres().length;
  $('#average').textContent=live.length?(live.reduce((a,x)=>a+Number(x.rating),0)/live.length).toFixed(1):'—';
  let list=visible(),grid=$('#grid');
  grid.innerHTML='';
  $('#empty').hidden=live.length>0;
  $('#notfound').hidden=live.length===0||list.length>0;
  $('#heading').textContent=$('#query').value||filters.genre.size||filters.tag.size?`検索結果 (${list.length})`:`すべての記録 (${live.length})`;
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
    n.querySelector('.tags').innerHTML=x.tags.slice(0,4).map(t=>`<span>${e(t)}</span>`).join('')+(x.tags.length>4?`<span>+${x.tags.length-4}</span>`:'');
    let p=n.querySelector('.cardbody p');
    p.textContent=x.notes||'';
    p.hidden=!x.notes;
    n.querySelector('footer small').textContent=date(x.createdAt)+' に追加';
    n.querySelector('.open').onclick=()=>openEditor(x);
    n.querySelector('.edit').onclick=()=>openEditor(x);
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
function renderGenreChips() {
  const box=$('#genre-chips'),current=$('#entryGenre').value.trim();
  box.innerHTML='';
  genres().forEach(name=> {
    const chip=document.createElement('button');
    chip.type='button';
    chip.className='tag-chip';
    chip.textContent=name;
    chip.setAttribute('aria-pressed',String(name===current));
    chip.onclick=()=> {
      $('#entryGenre').value=name;
      dirty=true;
      renderGenreChips()
    };
    box.append(chip)
  });
  box.hidden=!box.children.length
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
      dirty=true;
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
  dirty=true;
  renderFormTags()
}
function resetForm() {
  $('#form').reset();
  $('#id').value='';
  state.cover=null;
  state.formTags=[];
  renderFormTags();
  $('#ratingValue').textContent=Number($('#rating').value).toFixed(1);
  preview(null);
  dirty=false
}
function openEditor(x) {
  resetForm();
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
  renderGenreChips();
  $('#dialog').showModal();
  $('#title').focus()
}
const DISCARD_MESSAGE='保存していない変更があります。破棄して閉じますか？';
function closeEditor(force=false) {
  if(!force&&dirty&&!confirm(DISCARD_MESSAGE)) return;
  $('#dialog').close()
}
function commit(items,quiet=false) {
  const previous=state.items;
  state.items=items;
  if(save()) return true;
  state.items=previous;
  if(!quiet) alert('保存できませんでした。ブラウザの保存容量が足りない可能性があります。バックアップを書き出して、不要な記録や画像を減らしてください。');
  return false
}
function backup(prefix='yokattana') {
  let u=URL.createObjectURL(new Blob([JSON.stringify( {
    version:1,exportedAt:new Date().toISOString(),items:liveItems()
  },null,2)], {
    type:'application/json'
  })),a=document.createElement('a');
  a.href=u;
  a.download=`${prefix}-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(u)
}
$('#auth-button').onclick=toggleAuthentication;
$('#google-button').onclick=signInWithGoogle;
$('#close-auth').onclick=()=>$('#auth-dialog').close();
$('#add').onclick=()=>openEditor();
$('#emptyAdd').onclick=()=>openEditor();
$('#close').onclick=()=>closeEditor();
$('#cancel').onclick=()=>closeEditor();
// Esc で閉じるときも、未保存の変更を確認する
$('#dialog').addEventListener('cancel',event=> { if(dirty&&!confirm(DISCARD_MESSAGE)) event.preventDefault(); });
$('#form').addEventListener('input',()=> { dirty=true; });
$('#entryGenre').addEventListener('input',renderGenreChips);
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
    dirty=true;
    preview(state.cover)
  }
  catch(error) {
    alert(error.message);
    x.target.value=''
  }
};
$('#removeCover').onclick=()=> {
  state.cover=null;
  dirty=true;
  $('#cover').value='';
  preview(null)
};
$('#form').onsubmit=x=> {
  x.preventDefault();
  addFormTag();
  let id=$('#id').value,old=state.items.find(x=>x.id===id),entry= {
    id:id||crypto.randomUUID(),title:$('#title').value.trim(),genre:$('#entryGenre').value.trim(),rating:Number($('#rating').value),tags:[...state.formTags],notes:$('#notes').value.trim(),cover:state.cover,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),deleted:false
  };
  if(!commit(old?state.items.map(x=>x.id===id?entry:x):[...state.items,entry])) return;
  markPending([entry]);
  syncItem(entry);
  closeEditor(true);
  render()
};
$('#delete').onclick=()=> {
  let id=$('#id').value,old=state.items.find(x=>x.id===id);
  if(old&&confirm('この記録を削除しますか？')) {
    // 他の端末へ削除を伝えるため、中身を消した墓標として残す
    const tombstone= { ...old,title:'',notes:'',cover:null,tags:[],deleted:true,updatedAt:new Date().toISOString() };
    if(!commit(state.items.map(x=>x.id===id?tombstone:x))) return;
    markPending([tombstone]);
    syncItem(tombstone);
    closeEditor(true);
    render()
  }
};
['#query','#sort'].forEach(s=>$(s).addEventListener(s==='#query'?'input':'change',render));
document.querySelectorAll('.multi').forEach(root=> {
  const search=root.querySelector('.multi-search');
  search.addEventListener('input',()=>applyOptionSearch(root));
  // Enter で、絞り込まれた先頭の選択肢を切り替える
  search.addEventListener('keydown',event=> {
    if(event.key!=='Enter') return;
    event.preventDefault();
    root.querySelector('.multi-panel label:not([hidden]) input')?.click()
  });
  root.addEventListener('toggle',()=> {
    if(!root.open) { search.value=''; applyOptionSearch(root); return; }
    search.focus()
  })
});
document.querySelectorAll('.multi-clear').forEach(button=> {
  button.onclick=()=> {
    filters[button.closest('.multi').id.replace('-filter','')].clear();
    render()
  }
});
// 外側のクリックや Esc で、開いている選択肢を閉じる
document.addEventListener('click',event=> document.querySelectorAll('.multi[open]').forEach(d=> { if(!d.contains(event.target)) d.open=false; }));
document.addEventListener('keydown',event=> { if(event.key==='Escape') document.querySelectorAll('.multi[open]').forEach(d=> { d.open=false; }); });
$('#export').onclick=()=>backup();
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
      if(confirm(`${imported.length}件のデータで現在の記録を置き換えます。置き換える前の記録は、バックアップとして自動で保存します。よろしいですか？`)) {
        if(liveItems().length) backup('yokattana-before-import');
        const now=new Date().toISOString(),ids=new Set(imported.map(x=>x.id));
        // 読み込みに含まれない既存の記録は削除扱いにして、クラウドからも消す
        const removed=state.items.filter(x=>!x.deleted&&!ids.has(x.id)).map(x=>( { ...x,title:'',notes:'',cover:null,tags:[],deleted:true,updatedAt:now } ));
        const kept=state.items.filter(x=>x.deleted&&!ids.has(x.id));
        const next=imported.map(x=>( { ...x,updatedAt:now } ));
        if(!commit([...kept,...removed,...next])) return;
        markPending([...removed,...next]);
        syncItems([...removed,...next]);
        render();
        shrinkExistingCovers()
      }
    }
    catch {
      alert('読み込めませんでした。バックアップJSONを選択してください。')
    }
  };
  r.readAsText(f);
  x.target.value=''
};
// 別のタブでの変更を取り込む（編集中は触らない）
window.addEventListener('storage',event=> {
  if(event.key!==KEY||!event.newValue) return;
  state.items=mergeItems(state.items,load());
  if(!$('#dialog').open) render()
});
window.addEventListener('online',flushPending);
document.addEventListener('visibilitychange',()=> { if(document.visibilityState==='visible') flushPending(); });
setInterval(flushPending,60000);
render();
initializeCloud();
shrinkExistingCovers()
