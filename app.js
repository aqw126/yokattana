const KEY='yokattana-v1',OWNER_KEY='yokattana-owner',PENDING_KEY='yokattana-pending',$=s=>document.querySelector(s);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COVER=/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const TRASH_DAYS=30,CARD_PAGE=24,TOMBSTONE_DAYS=90,SYNC_CHUNK=20,PAGE_SIZE=100,COVER_LIMIT=150000;
const cloud=window.supabase?.createClient(window.SUPABASE_CONFIG?.url,window.SUPABASE_CONFIG?.publishableKey);
let shownLimit=CARD_PAGE,lastView='',currentUser=null,flushing=false,shrinking=false,dirty=false;

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
  const merged=compactTrash(mergeItems(state.items,[...remote.values()]));
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
function hasContent(x) {
  return!!(x.title||x.notes||x.cover||x.tags.length)
}
function emptyOf(x,now) {
  return { ...x,title:'',notes:'',cover:null,tags:[],readAt:null,deleted:true,updatedAt:now }
}
// ごみ箱に入れて30日たった記録は、中身を消して、削除したことだけを残す
function compactTrash(list) {
  const cutoff=Date.now()-TRASH_DAYS*86400000,now=new Date().toISOString();
  return list.map(x=>x.deleted&&hasContent(x)&&new Date(x.updatedAt)<cutoff?emptyOf(x,now):x)
}
function validDay(v) {
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d=new Date(v+'T00:00:00Z');
  return !isNaN(d)&&d.toISOString().slice(0,10)===v?v:null
}
function localDay(d=new Date()) {
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`
}
// 振り返りでの基準日: 読んだ日があればそれ、なければ追加した日
function basisDay(item) {
  return item.readAt||localDay(new Date(item.createdAt))
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
    readAt:validDay(raw.readAt),createdAt,updatedAt:validDate(raw.updatedAt,createdAt),deleted
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
  const root=$(`#${kind}-filter`),panel=root.querySelector('.multi-panel'),selected=filters[kind],key=values.join('\u0000');
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
  return r.sort((a,b)=>compareItems(s,a,b))
}
function compareItems(s,a,b) {
  const added=new Date(b.createdAt)-new Date(a.createdAt);
  if(s==='old') return-added;
  if(s==='high') return b.rating-a.rating||added;
  if(s==='low') return a.rating-b.rating||added;
  if(s==='title') return a.title.localeCompare(b.title,'ja');
  if(s==='read'||s==='readold') {
    // 読んだ日が未入力の記録は、どちらの並びでも最後にする
    if(!a.readAt||!b.readAt) return a.readAt?-1:b.readAt?1:added;
    return(s==='read'?b.readAt.localeCompare(a.readAt):a.readAt.localeCompare(b.readAt))||added
  }
  return added
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
  const view=JSON.stringify([$('#query').value,$('#sort').value,[...filters.genre],[...filters.tag]]);
  if(view!==lastView) { lastView=view; shownLimit=CARD_PAGE; }
  grid.innerHTML='';
  $('#more').hidden=list.length<=shownLimit;
  $('#more').textContent=`さらに表示（残り${list.length-shownLimit}件）`;
  const trashed=trashItems().length;
  $('#open-trash').textContent=trashed?`ごみ箱 (${trashed})`:'ごみ箱';
  $('#empty').hidden=live.length>0;
  $('#notfound').hidden=live.length===0||list.length>0;
  $('#heading').textContent=$('#query').value||filters.genre.size||filters.tag.size?`検索結果 (${list.length})`:`すべての記録 (${live.length})`;
  let tpl=$('#card');
  list.slice(0,shownLimit).forEach(x=> {
    let n=tpl.content.cloneNode(true),img=n.querySelector('img'),letter=n.querySelector('.art span');
    if(x.cover) {
      img.loading='lazy';
      img.decoding='async';
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
    n.querySelector('footer small').textContent=x.readAt?date(x.readAt+'T00:00:00')+' に読んだ':date(x.createdAt)+' に追加';
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
  $('#readAt').max=localDay();
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
    $('#readAt').value=x.readAt||'';
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
    id:id||crypto.randomUUID(),title:$('#title').value.trim(),genre:$('#entryGenre').value.trim(),rating:Number($('#rating').value),readAt:validDay($('#readAt').value),tags:[...state.formTags],notes:$('#notes').value.trim(),cover:state.cover,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),deleted:false
  };
  if(!commit(old?state.items.map(x=>x.id===id?entry:x):[...state.items,entry])) return;
  markPending([entry]);
  syncItem(entry);
  closeEditor(true);
  render()
};
$('#delete').onclick=()=> {
  let id=$('#id').value,old=state.items.find(x=>x.id===id);
  if(old&&confirm('この記録をごみ箱に移動しますか？')) {
    // 他の端末へも伝わるよう、削除済みの印を付けて、30日間は戻せるように残す
    const trashed= { ...old,deleted:true,updatedAt:new Date().toISOString() };
    if(!commit(state.items.map(x=>x.id===id?trashed:x))) return;
    markPending([trashed]);
    syncItem(trashed);
    closeEditor(true);
    render();
    showToast(`ごみ箱に移動しました。${TRASH_DAYS}日間は、ごみ箱から戻せます。`)
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
$('#export-csv').onclick=exportCsv;
$('#import').onclick=()=>$('#file').click();
$('#import-data').onclick=()=>$('#file').click();
$('#open-data').onclick=()=> {
  $('#account-section').hidden=!currentUser;
  $('#data-dialog').showModal()
};
$('#close-data').onclick=()=>$('#data-dialog').close();
$('#delete-account').onclick=deleteAccount;
$('#more').onclick=()=> {
  shownLimit+=CARD_PAGE;
  render()
};

// CSV の書き出しと読み込み
function csvCell(value) {
  let text=String(value??'');
  // 表計算ソフトで数式として実行されないよう、先頭に印を付ける
  if(/^[=+\-@\t\r]/.test(text)) text="'"+text;
  return/[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text
}
function exportCsv() {
  const header=['タイトル','ジャンル','評価','読んだ日','タグ','メモ','追加日'];
  const rows=liveItems().sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)).map(x=>[x.title,x.genre,x.rating.toFixed(1),x.readAt||'',x.tags.join(';'),x.notes,localDay(new Date(x.createdAt))]);
  const text='\ufeff'+[header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
  const url=URL.createObjectURL(new Blob([text], { type:'text/csv;charset=utf-8' })),a=document.createElement('a');
  a.href=url;
  a.download=`yokattana-${localDay()}.csv`;
  a.click();
  URL.revokeObjectURL(url)
}
function parseCsv(text) {
  const rows=[];
  let row=[],cell='',quoted=false;
  if(text.charCodeAt(0)===0xFEFF) text=text.slice(1);
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) {
      if(c==='"') {
        if(text[i+1]==='"') { cell+='"'; i++; }
        else quoted=false
      }
      else cell+=c
    }
    else if(c==='"') quoted=true;
    else if(c===',') { row.push(cell); cell=''; }
    else if(c==='\n'||c==='\r') {
      if(c==='\r'&&text[i+1]==='\n') i++;
      row.push(cell);
      cell='';
      rows.push(row);
      row=[]
    }
    else cell+=c
  }
  if(cell!==''||row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r=>r.some(c=>c.trim()!==''))
}
const CSV_FIELDS= {
  title:['タイトル','書名','作品名','title','name'],
  genre:['ジャンル','カテゴリ','カテゴリー','種別','genre','category'],
  rating:['評価','★','rating','score'],
  readAt:['読んだ日','読了日','鑑賞日','視聴日','日付','readat','date'],
  tags:['タグ','tags','tag'],
  notes:['メモ','感想','レビュー','読書メモ(ネタバレ)','読書メモ','コメント','notes','review','comment'],
  createdAt:['追加日','登録日時','登録日','createdat']
};
function csvDay(value) {
  const m=String(value??'').match(/(\d{4})[\/\-.年]\s*(\d{1,2})[\/\-.月]\s*(\d{1,2})/);
  return m?validDay(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`):null
}
function csvItems(text) {
  const rows=parseCsv(text);
  if(rows.length<2) return null;
  const header=rows[0].map(h=>h.replace(/^\ufeff/,'').trim().toLowerCase());
  const columns=Object.fromEntries(Object.entries(CSV_FIELDS).map(([key,names])=>[key,header.map((h,i)=>names.some(n=>n.toLowerCase()===h)?i:-1).filter(i=>i>=0)]));
  if(!columns.title.length) return null;
  const now=new Date().toISOString();
  return rows.slice(1).map(row=> {
    const cells=key=>columns[key].map(i=>String(row[i]??'').replace(/^'(?=[=+\-@\t\r])/,'').trim()).filter(Boolean);
    const stars=cells('rating')[0]||'',rating=/^[★☆]+$/.test(stars)?[...stars].filter(c=>c==='★').length:parseFloat(stars);
    const added=csvDay(cells('createdAt')[0]);
    return normalizeItem( {
      id:crypto.randomUUID(),title:cells('title')[0],genre:cells('genre')[0],rating,
      tags:cells('tags').join(';').split(/[;；,，、]+/),notes:cells('notes').join('\n\n'),
      readAt:csvDay(cells('readAt')[0]),createdAt:added?new Date(added+'T00:00:00').toISOString():now,updatedAt:now
    })
  }).filter(Boolean)
}
async function readText(file) {
  const buffer=await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal:true }).decode(buffer); }
  catch { return new TextDecoder('shift_jis').decode(buffer); }
}
function importJson(text) {
  const o=JSON.parse(text),a=Array.isArray(o)?o:o.items;
  if(!Array.isArray(a)) throw 0;
  const imported=a.map(normalizeItem).filter(Boolean);
  if(!imported.length&&a.length) throw 0;
  if(!confirm(`${imported.length}件のデータで現在の記録を置き換えます。置き換える前の記録は、バックアップとして自動で保存し、ごみ箱にも${TRASH_DAYS}日間残ります。よろしいですか？`)) return;
  if(liveItems().length) backup('yokattana-before-import');
  const now=new Date().toISOString(),ids=new Set(imported.map(x=>x.id));
  // 読み込みに含まれない既存の記録は、ごみ箱へ移す
  const removed=state.items.filter(x=>!x.deleted&&!ids.has(x.id)).map(x=>( { ...x,deleted:true,updatedAt:now } ));
  const kept=state.items.filter(x=>x.deleted&&!ids.has(x.id));
  const next=imported.map(x=>( { ...x,updatedAt:now } ));
  if(!commit([...kept,...removed,...next])) return;
  markPending([...removed,...next]);
  syncItems([...removed,...next]);
  render();
  shrinkExistingCovers()
}
function importCsv(text) {
  const items=csvItems(text);
  if(!items||!items.length) throw 0;
  const key=x=>`${x.title}|${x.readAt||''}`,known=new Set(liveItems().map(key));
  const additions=items.filter(x=>!known.has(key(x)));
  const skipped=items.length-additions.length;
  if(!additions.length) { alert(`追加できる記録がありませんでした（${skipped}件は、すでにある記録と同じです）。`); return; }
  if(!confirm(`${additions.length}件の記録を追加します${skipped?`（同じ記録の${skipped}件は読み飛ばします）`:''}。評価は、このアプリの範囲（★3〜5）に収めます。よろしいですか？`)) return;
  if(!commit([...state.items,...additions])) return;
  markPending(additions);
  syncItems(additions);
  render();
  showToast(`${additions.length}件の記録を追加しました。`)
}
$('#file').onchange=async x=> {
  const f=x.target.files[0];
  x.target.value='';
  if(!f) return;
  try {
    const text=await readText(f);
    if(/^[\[{]/.test(text.replace(/^\ufeff/,'').trimStart())) importJson(text);
    else importCsv(text);
    if($('#data-dialog').open) $('#data-dialog').close()
  }
  catch {
    alert('読み込めませんでした。このアプリで書き出したJSON、またはタイトルの列があるCSVを選んでください。')
  }
};

// アカウントの削除（Supabase 側の関数 delete_my_account が必要）
async function deleteAccount() {
  if(!currentUser) return;
  if(!confirm('クラウド上のアカウントと、同期した記録をすべて削除します。この端末の記録も消え、元に戻せません。先にバックアップを書き出しましたか？ 続けますか？')) return;
  if(prompt('本当に削除するには「削除」と入力してください。')!=='削除') return;
  try {
    const { error }=await cloud.rpc('delete_my_account');
    if(error) throw error
  }
  catch(error) {
    alert(/delete_my_account|function/i.test(String(error?.message))?'アカウントの削除機能が、まだ有効になっていません。supabase-schema.sql の delete_my_account を、Supabase で実行してください。':'削除できませんでした。通信状況を確認して、もう一度お試しください。');
    return
  }
  try { await cloud.auth.signOut(); }
  catch {}
  if(currentUser) applySignedOut();
  $('#data-dialog').close();
  showToast('アカウントと、クラウド上の記録を削除しました。')
}

// ごみ箱
function trashItems() {
  return state.items.filter(x=>x.deleted&&x.title).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))
}
function applyTrash(items,change) {
  const ids=new Set(items.map(x=>x.id)),next=state.items.map(x=>ids.has(x.id)?change(x):x),changed=next.filter(x=>ids.has(x.id));
  if(!changed.length||!commit(next)) return;
  markPending(changed);
  syncItems(changed);
  render();
  renderTrash()
}
function renderTrash() {
  const list=$('#trash-list'),items=trashItems();
  list.innerHTML='';
  $('#empty-trash').hidden=!items.length;
  if(!items.length) {
    const li=document.createElement('li');
    li.className='manage-empty';
    li.textContent='ごみ箱は空です';
    list.append(li)
  }
  items.forEach(x=> {
    const li=document.createElement('li'),name=document.createElement('span'),days=document.createElement('small'),restore=document.createElement('button'),purge=document.createElement('button');
    const left=Math.max(0,TRASH_DAYS-Math.floor((Date.now()-new Date(x.updatedAt))/86400000));
    name.className='manage-name';
    name.textContent=`${x.title}（${x.genre}）`;
    days.className='trash-days';
    days.textContent=`あと${left}日`;
    restore.type='button';
    restore.className='link';
    restore.textContent='戻す';
    restore.onclick=()=>applyTrash([x],y=>( { ...y,deleted:false,updatedAt:new Date().toISOString() } ));
    purge.type='button';
    purge.className='link danger';
    purge.textContent='完全に削除';
    purge.onclick=()=> {
      if(!confirm(`「${x.title}」を完全に削除します。元に戻せません。`)) return;
      const now=new Date().toISOString();
      applyTrash([x],y=>emptyOf(y,now))
    };
    li.append(name,days,restore,purge);
    list.append(li)
  })
}
$('#open-trash').onclick=()=> {
  renderTrash();
  $('#trash-dialog').showModal()
};
$('#close-trash').onclick=()=>$('#trash-dialog').close();
$('#empty-trash').onclick=()=> {
  const items=trashItems();
  if(!items.length||!confirm(`ごみ箱の${items.length}件を、すべて完全に削除します。元に戻せません。`)) return;
  const now=new Date().toISOString();
  applyTrash(items,y=>emptyOf(y,now))
};
$('#readToday').onclick=()=> {
  $('#readAt').value=localDay();
  dirty=true
};

// ジャンル・タグの整理
function countBy(getter,items=liveItems()) {
  const counts=new Map();
  items.forEach(x=>getter(x).forEach(key=>counts.set(key,(counts.get(key)||0)+1)));
  return[...counts]
}
function renderManage() {
  fillManage($('#manage-genres'),countBy(x=>[x.genre]).sort((a,b)=>a[0].localeCompare(b[0],'ja')),'genre');
  fillManage($('#manage-tags'),countBy(x=>x.tags).sort((a,b)=>a[0].localeCompare(b[0],'ja')),'tag')
}
function fillManage(list,rows,kind) {
  list.innerHTML='';
  if(!rows.length) {
    const li=document.createElement('li');
    li.className='manage-empty';
    li.textContent='まだありません';
    list.append(li)
  }
  rows.forEach(([name,count])=> {
    const li=document.createElement('li'),label=document.createElement('span'),rename=document.createElement('button');
    label.className='manage-name';
    label.textContent=`${name}（${count}件）`;
    rename.type='button';
    rename.className='link';
    rename.textContent='名前を変更';
    rename.onclick=()=>renameOption(kind,name);
    li.append(label,rename);
    if(kind==='tag') {
      const remove=document.createElement('button');
      remove.type='button';
      remove.className='link danger';
      remove.textContent='削除';
      remove.onclick=()=>deleteTag(name);
      li.append(remove)
    }
    list.append(li)
  })
}
function applyBulk(next,changed) {
  if(!changed.length||!commit(next)) return;
  markPending(changed);
  syncItems(changed);
  render();
  renderManage()
}
function renameOption(kind,from) {
  const input=prompt(`「${from}」の新しい名前`,from);
  if(input===null) return;
  const to=input.trim().slice(0,kind==='genre'?40:80);
  if(!to||to===from) return;
  if((kind==='genre'?genres():alltags()).includes(to)&&!confirm(`「${to}」はすでにあります。「${from}」の記録を「${to}」にまとめますか？`)) return;
  const now=new Date().toISOString(),changed=[];
  const next=state.items.map(x=> {
    if(x.deleted) return x;
    let y=x;
    if(kind==='genre'&&x.genre===from) y= { ...x,genre:to,updatedAt:now };
    if(kind==='tag'&&x.tags.includes(from)) y= { ...x,tags:[...new Set(x.tags.map(t=>t===from?to:t))],updatedAt:now };
    if(y!==x) changed.push(y);
    return y
  });
  applyBulk(next,changed)
}
function deleteTag(tag) {
  const count=liveItems().filter(x=>x.tags.includes(tag)).length;
  if(!confirm(`タグ「${tag}」を、${count}件の記録から外しますか？ 記録そのものは消えません。`)) return;
  const now=new Date().toISOString(),changed=[];
  const next=state.items.map(x=> {
    if(x.deleted||!x.tags.includes(tag)) return x;
    const y= { ...x,tags:x.tags.filter(t=>t!==tag),updatedAt:now };
    changed.push(y);
    return y
  });
  applyBulk(next,changed)
}
$('#open-manage').onclick=()=> {
  renderManage();
  $('#manage-dialog').showModal()
};
$('#close-manage').onclick=()=>$('#manage-dialog').close();

// 振り返り
function drawBars(box,rows) {
  box.innerHTML='';
  if(!rows.length) {
    const empty=document.createElement('p');
    empty.className='manage-empty';
    empty.textContent='データがありません';
    box.append(empty);
    return
  }
  const max=Math.max(1,...rows.map(r=>r[1]));
  rows.forEach(([label,value])=> {
    const row=document.createElement('div'),name=document.createElement('span'),track=document.createElement('div'),fill=document.createElement('div'),num=document.createElement('span');
    row.className='bar-row';
    name.className='bar-label';
    name.textContent=label;
    track.className='bar-track';
    fill.className='bar-fill';
    fill.style.width=`${value/max*100}%`;
    track.append(fill);
    num.className='bar-count';
    num.textContent=value;
    row.append(name,track,num);
    box.append(row)
  })
}
function drawReview() {
  const year=$('#review-year').value,items=liveItems().filter(x=>year==='all'||basisDay(x).startsWith(year));
  const average=items.length?(items.reduce((a,x)=>a+x.rating,0)/items.length).toFixed(1):'—';
  const top=items.filter(x=>x.rating>=4.5).sort((a,b)=>b.rating-a.rating||basisDay(b).localeCompare(basisDay(a)));
  const summary=$('#review-summary');
  summary.innerHTML='';
  [['記録',items.length],['平均評価',average],['特によかった',top.length]].forEach(([label,value])=> {
    const card=document.createElement('div'),strong=document.createElement('strong'),span=document.createElement('span');
    strong.textContent=value;
    span.textContent=label;
    card.append(strong,span);
    summary.append(card)
  });
  if(year==='all') {
    $('#review-time-title').textContent='年ごとの件数';
    drawBars($('#review-time'),countBy(x=>[basisDay(x).slice(0,4)],items).sort((a,b)=>a[0].localeCompare(b[0])).map(([y,n])=>[`${y}年`,n]))
  }
  else {
    $('#review-time-title').textContent='月ごとの件数';
    const byMonth=new Map(countBy(x=>[Number(basisDay(x).slice(5,7))],items));
    drawBars($('#review-time'),Array.from({ length:12 },(_,i)=>[`${i+1}月`,byMonth.get(i+1)||0]))
  }
  const ranked=rows=>rows.sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ja')).slice(0,8);
  drawBars($('#review-genres'),ranked(countBy(x=>[x.genre],items)));
  drawBars($('#review-tags'),ranked(countBy(x=>x.tags,items)));
  const list=$('#review-top');
  list.innerHTML='';
  if(!top.length) {
    const li=document.createElement('li');
    li.className='manage-empty';
    li.textContent='まだありません';
    list.append(li)
  }
  top.slice(0,20).forEach(x=> {
    const li=document.createElement('li'),name=document.createElement('span');
    name.className='manage-name';
    name.textContent=`★${x.rating.toFixed(1)}　${x.title}（${x.genre}）`;
    li.append(name);
    list.append(li)
  })
}
function openReview() {
  const years=[...new Set(liveItems().map(x=>basisDay(x).slice(0,4)))].sort().reverse(),select=$('#review-year');
  select.innerHTML='<option value="all">すべての期間</option>';
  years.forEach(y=> {
    const option=document.createElement('option');
    option.value=y;
    option.textContent=`${y}年`;
    select.append(option)
  });
  const thisYear=String(new Date().getFullYear());
  select.value=years.includes(thisYear)?thisYear:'all';
  drawReview();
  $('#review-dialog').showModal()
}
$('#open-review').onclick=openReview;
$('#review-year').onchange=drawReview;
$('#close-review').onclick=()=>$('#review-dialog').close();

// 別のタブでの変更を取り込む（編集中は触らない）
window.addEventListener('storage',event=> {
  if(event.key!==KEY||!event.newValue) return;
  state.items=mergeItems(state.items,load());
  if(!$('#dialog').open) render()
});
window.addEventListener('online',flushPending);
document.addEventListener('visibilitychange',()=> { if(document.visibilityState==='visible') flushPending(); });
setInterval(flushPending,60000);
{
  const next=compactTrash(state.items),changed=next.filter((x,i)=>x!==state.items[i]);
  if(changed.length) commit(next,true)
}
render();
initializeCloud();
shrinkExistingCovers()
