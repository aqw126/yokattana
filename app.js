const KEY='yokattana-v1',OWNER_KEY='yokattana-owner',PENDING_KEY='yokattana-pending',$=s=>document.querySelector(s);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COVER=/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const TRASH_DAYS=30,CARD_PAGE=24,TOMBSTONE_DAYS=90,SYNC_CHUNK=20,PAGE_SIZE=100,COVER_LIMIT=150000;
const cloud=window.supabase?.createClient(window.SUPABASE_CONFIG?.url,window.SUPABASE_CONFIG?.publishableKey);
// CSP の Trusted Types で、HTML 文字列やスクリプトの URL を渡す処理は禁止している。例外はこの2つだけ:
// 国立国会図書館サーチの XML を読むこと（DOMParser の文書ではスクリプトは動かない）と、Service Worker の登録
const trusted=window.trustedTypes?.createPolicy('yokattana', {
  createHTML:xml=> { if(!/^\s*(<\?xml|<rss)/.test(xml)) throw new TypeError('XML ではありません'); return xml; },
  createScriptURL:url=> { if(url!=='sw.js') throw new TypeError(url); return url; }
})||{ createHTML:x=>x,createScriptURL:x=>x };
let shownLimit=CARD_PAGE,lastView='',picking=false,currentUser=null,flushing=false,shrinking=false,dirty=false,limitWarned=false;

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
  // 開いているダイアログの手前に出すため、いちばん上のダイアログの中に置く
  (document.querySelectorAll('dialog[open]').item(document.querySelectorAll('dialog[open]').length-1)||document.body).append(toast);
  toast.textContent=message;
  toast.hidden=false;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=> { toast.hidden=true; document.body.append(toast); },5000)
}
function updateSyncStatus(failed=false) {
  const status=$('#sync-status');
  let message='この端末に保存中',connected=false;
  if(!navigator.onLine) message=currentUser?`オフライン（接続すると同期します）`:'オフライン（この端末に保存中）';
  else if(!cloud) message='同期設定が見つかりません';
  else if(!currentUser) message='ログインすると自動同期';
  else if(failed||pending.size) message=pending.size?`同期待ち ${pending.size}件`:'同期に失敗しました';
  else if(navigator.onLine) { message='自動同期中'; connected=true; }
  status.textContent=message;
  status.classList.toggle('connected',connected);
  const label=$('#account-label'),account=currentUser?.email||currentUser?.user_metadata?.email||currentUser?.user_metadata?.name||'';
  label.hidden=!currentUser;
  label.textContent=currentUser?`ログイン中：${account||'Googleアカウント'}`:'';
  label.title=account
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
    catch(error) {
      chunk.forEach(item=>pending.add(item.id));
      ok=false;
      // クラウドの上限（supabase-schema.sql の guard_library_item）に達したら、一度だけ知らせる
      if(!limitWarned&&(String(error?.message).includes('library_limit')||error?.code==='23514')) {
        limitWarned=true;
        showToast('クラウドの保存上限（1人5000件・合計100MB、1件300KB）に達したため、同期できませんでした。この端末には保存されています。不要な記録や表紙画像を減らしてください。')
      }
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
// 未来の日時（時計のずれた端末で保存したもの）は今に直す。同期は新しい方が勝つので、残すと二度と上書きできなくなる
const CLOCK_SKEW=5*60000;
function notFuture(iso) {
  return new Date(iso)>Date.now()+CLOCK_SKEW?new Date().toISOString():iso
}
function hasContent(x) {
  return!!(x.title||x.notes||x.quote||x.cover||x.tags.length)
}
function emptyOf(x,now) {
  return { ...x,title:'',notes:'',quote:'',spoiler:false,cover:null,tags:[],readAt:null,deleted:true,updatedAt:now }
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
// ネタバレは、メモ・引用の中の「||」で囲んだ部分。「最後に||犯人は兄||だと分かる」
const SPOILER=/\|\|([\s\S]+?)\|\|/g;
function hasSpoiler(text) {
  return new RegExp(SPOILER.source).test(String(text||''))
}
// 文字列を、ふつうの部分とネタバレの部分に分ける。閉じていない「||」は、そのまま文字として扱う
function spoilerParts(text) {
  const parts=[],value=String(text||'');
  let last=0;
  for(const m of value.matchAll(SPOILER)) {
    if(m.index>last) parts.push( { text:value.slice(last,m.index),spoiler:false });
    parts.push( { text:m[1],spoiler:true });
    last=m.index+m[0].length
  }
  if(last<value.length) parts.push( { text:value.slice(last),spoiler:false });
  return parts
}
// 共有で「ネタバレの部分を除く」ときに使う
function withoutSpoilers(text) {
  return String(text||'').replace(SPOILER,'（ネタバレのため省略）').trim()
}
// 以前の「記録全体がネタバレ」の印は、メモ・引用の全体を「||」で囲む形に置き換える（隠れていたものが見えないように）
function wrapSpoiler(text) {
  return text&&!hasSpoiler(text)?`||${text}||`:text
}
function normalizeItem(raw) {
  if(!raw||typeof raw!=='object') return null;
  const deleted=raw.deleted===true,title=String(raw.title??'').trim();
  if(!deleted&&!title) return null;
  const createdAt=notFuture(validDate(raw.createdAt,new Date().toISOString()));
  return {
    id:typeof raw.id==='string'&&UUID.test(raw.id)?raw.id:crypto.randomUUID(),
    title,genre:String(raw.genre??'').trim()||'未分類',
    rating:Math.min(5,Math.max(3,Number(raw.rating)||3)),
    tags:Array.isArray(raw.tags)?[...new Set(raw.tags.map(t=>String(t).trim()).filter(Boolean))]:[],
    ...(()=> {
      const legacy=raw.spoiler===true;
      let notes=String(raw.notes??'').trim(),quote=String(raw.quote??'').trim().slice(0,1000);
      if(legacy) { notes=wrapSpoiler(notes); quote=wrapSpoiler(quote); }
      return { notes,quote,spoiler:hasSpoiler(notes)||hasSpoiler(quote) }
    })(),
    cover:typeof raw.cover==='string'&&COVER.test(raw.cover)?raw.cover:null,
    readAt:validDay(raw.readAt),createdAt,updatedAt:notFuture(validDate(raw.updatedAt,createdAt)),deleted
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
// 長辺600pxのJPEGに縮小する。細かい画像で COVER_LIMIT を超えるときは、さらに小さく・粗くする（クラウドは1件300KBまで）
function scaleImage(src) {
  return new Promise((resolve,reject)=> {
    const img=new Image();
    img.onload=()=> {
      let url='';
      for(const [size,quality] of [[600,0.8],[600,0.6],[450,0.6],[300,0.5]]) {
        const scale=Math.min(1,size/Math.max(img.width,img.height)),c=document.createElement('canvas'),g=c.getContext('2d');
        c.width=Math.max(1,Math.round(img.width*scale));
        c.height=Math.max(1,Math.round(img.height*scale));
        g.fillStyle='#fff';
        g.fillRect(0,0,c.width,c.height);
        g.drawImage(img,0,0,c.width,c.height);
        url=c.toDataURL('image/jpeg',quality);
        if(url.length<=COVER_LIMIT) break
      }
      resolve(url)
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
function genres() {
  return[...new Set(liveItems().map(x=>x.genre))].sort((a,b)=>a.localeCompare(b,'ja'))
}
function alltags() {
  return[...new Set(liveItems().flatMap(x=>x.tags))].sort((a,b)=>a.localeCompare(b,'ja'))
}
const filters= { genre:new Set(),tag:new Set() },filterKeys= {},selection=new Set();
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
    panel.replaceChildren();
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
    let text=[x.title,x.genre,...x.tags,x.notes||'',x.quote||''].join(' ').toLocaleLowerCase('ja');
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
// カードでは、ネタバレの部分を「ネタバレ」の印に置き換える（カード全体が編集を開くボタンなので、その場では開けない）
function maskedSpoilers(text) {
  return spoilerParts(text).map(part=> {
    if(!part.spoiler) return document.createTextNode(part.text);
    const mask=document.createElement('span');
    mask.className='spoiler-mask';
    mask.textContent='ネタバレ';
    return mask
  })
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
  grid.replaceChildren();
  $('#more').hidden=list.length<=shownLimit;
  $('#more').textContent=`さらに表示（残り${list.length-shownLimit}件）`;
  const trashed=trashItems().length;
  $('#open-trash').textContent=trashed?`ごみ箱 (${trashed})`:'ごみ箱';
  $('#empty').hidden=live.length>0;
  $('#notfound').hidden=live.length===0||list.length>0;
  $('#heading').textContent=$('#query').value||filters.genre.size||filters.tag.size?`検索結果 (${list.length})`:`すべての記録 (${live.length})`;
  let tpl=$('#card');
  grid.classList.toggle('picking',picking);
  [...selection].filter(id=>!live.some(x=>x.id===id)).forEach(id=>selection.delete(id));
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
    n.querySelector('.tags').replaceChildren(...[...x.tags.slice(0,4),...(x.tags.length>4?[`+${x.tags.length-4}`]:[])].map(t=> {
      const span=document.createElement('span');
      span.textContent=t;
      return span
    }));
    let p=n.querySelector('.cardbody p');
    p.replaceChildren(...maskedSpoilers(x.notes));
    p.hidden=!x.notes;
    const quote=n.querySelector('blockquote');
    quote.replaceChildren(...maskedSpoilers(x.quote));
    quote.hidden=!x.quote;
    n.querySelector('.spoiler-badge').hidden=!x.spoiler;
    n.querySelector('footer small').textContent=x.readAt?date(x.readAt+'T00:00:00')+' に読んだ':date(x.createdAt)+' に追加';
    const card=n.querySelector('article'),pick=n.querySelector('.pick'),box=n.querySelector('.pick-box');
    pick.hidden=!picking;
    box.checked=selection.has(x.id);
    box.setAttribute('aria-label',`${x.title}を共有に含める`);
    card.classList.toggle('picked',box.checked);
    box.onchange=()=> { setPicked(x.id,box.checked); card.classList.toggle('picked',box.checked); };
    // 選ぶモードでは、カードを押すと編集ではなく、選択の切り替えになる
    const activate=()=> { if(picking) { box.checked=!box.checked; box.onchange(); } else openEditor(x); };
    n.querySelector('.open').onclick=activate;
    n.querySelector('.edit').onclick=activate;
    n.querySelector('.open').setAttribute('aria-label',`${x.title}を開く`);
    n.querySelector('.edit').setAttribute('aria-label',`${x.title}を編集`);
    grid.append(n)
  });
  updatePickBar()
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
  box.replaceChildren();
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
  container.replaceChildren();
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
// 作品の自動入力: タイトルで、本（国立国会図書館サーチ）と漫画・アニメ（AniList）を探す
const ANILIST='https://graphql.anilist.co',NDL='https://ndlsearch.ndl.go.jp/api/opensearch',WORK_TAGS=6;
const ANILIST_QUERY='query($q:String){Page(perPage:8){media(search:$q,isAdult:false,sort:SEARCH_MATCH){type format title{native romaji} genres startDate{year} coverImage{large medium} staff(perPage:3,sort:RELEVANCE){edges{role node{name{native full}}}} studios(isMain:true){nodes{name}}}}}';
const ANILIST_GENRES= {
  Action:'アクション',Adventure:'冒険',Comedy:'コメディ',Drama:'ドラマ',Fantasy:'ファンタジー',Horror:'ホラー','Mahou Shoujo':'魔法少女',Mecha:'ロボット',Music:'音楽',Mystery:'ミステリー',Psychological:'心理',Romance:'恋愛','Sci-Fi':'SF','Slice of Life':'日常',Sports:'スポーツ',Supernatural:'超常',Thriller:'サスペンス'
};
// ジャンル名の候補。すでに使っている名前があれば、それを優先する
const WORK_GENRES= { anime:['アニメ'],manga:['漫画','マンガ','コミック'],lightnovel:['ライトノベル','ラノベ','小説'],novel:['小説'],book:['本','書籍'],movie:['映画'],drama:['ドラマ','テレビドラマ'],game:['ゲーム'] };
// 映画・ドラマ・ゲームは Wikidata で探す。種類（P31）で見分け、アニメは AniList と重なるので除く
const WIKIDATA='https://www.wikidata.org/w/api.php';
const WIKIDATA_KINDS= {
  movie:['Q11424','Q24869','Q506240','Q93204','Q24862','Q29168811','Q202866','Q229390','Q17517379'],
  drama:['Q5398426','Q1259759','Q526877'],
  game:['Q7889','Q865493']
};
const WIKIDATA_ANIME=['Q20650540','Q63952888','Q1107'];
// 映画・ドラマは、TMDB の API キー（tmdb-config.js）があれば TMDB で探す（ポスターつき）。そのときの Wikidata はゲームだけ
const TMDB='https://api.themoviedb.org/3',TMDB_IMAGE='https://image.tmdb.org/t/p/';
const TMDB_GENRES= {
  28:'アクション',12:'冒険',16:'アニメーション',35:'コメディ',80:'犯罪',99:'ドキュメンタリー',18:'ドラマ',10751:'ファミリー',14:'ファンタジー',36:'歴史',27:'ホラー',10402:'音楽',9648:'ミステリー',10749:'恋愛',878:'SF',53:'サスペンス',10752:'戦争',37:'西部劇',
  10759:'アクション',10762:'キッズ',10764:'リアリティ',10765:'SF',10766:'昼ドラ',10768:'戦争・政治'
};
function tmdbKey() {
  const key=String(window.TMDB_CONFIG?.apiKey||'').trim();
  return /^[0-9a-f]{32}$/i.test(key)?key:''
}
// 本の表紙は Apple Books の検索で探す（国立国会図書館サーチには表紙がないため）
const ITUNES='https://itunes.apple.com/search';
let workSearchId=0;
function workKey(v) {
  return String(v||'').normalize('NFKC').replace(/[\s・:：\-－]/g,'').toLocaleLowerCase('ja')
}
function pickGenre(kind) {
  const names=WORK_GENRES[kind]||WORK_GENRES.book,have=genres();
  return names.find(x=>have.includes(x))||names[0]
}
function personName(raw) {
  // 「宮部, みゆき, 1960-」「宮部／みゆき」→「宮部みゆき」
  const name=String(raw||'').replace(/,\s*\d{4}-(\d{4})?\s*$/,'').trim();
  return /[぀-ヿ㐀-鿿]/.test(name)?name.replace(/[\s,，／/]+/g,''):name.replace(/\s*,\s*/g,' ')
}
function parseAniList(json) {
  return(json?.data?.Page?.media||[]).map(m=> {
    const anime=m.type==='ANIME',kind=anime?'anime':m.format==='NOVEL'?'lightnovel':'manga';
    const creator=anime?m.studios?.nodes?.[0]?.name:(m.staff?.edges||[]).find(x=>/^(Story|Original Creator)/.test(x.role))?.node?.name;
    const author=typeof creator==='string'?creator:creator?.native||creator?.full||'';
    const genreTags=(m.genres||[]).map(g=>ANILIST_GENRES[g]).filter(Boolean);
    return {
      source:'anilist',kind,title:(m.title?.native||m.title?.romaji||'').trim(),author:personName(author),year:m.startDate?.year||null,
      tags:[...new Set([personName(author),...genreTags].filter(Boolean))].slice(0,WORK_TAGS),
      thumb:m.coverImage?.medium||'',cover:m.coverImage?.large||m.coverImage?.medium||''
    }
  }).filter(x=>x.title)
}
function parseNdl(xml,query) {
  const doc=new DOMParser().parseFromString(trusted.createHTML(xml),'application/xml'),q=workKey(query),groups=new Map();
  const text=(item,name)=>[...item.getElementsByTagName(name)].map(x=>x.textContent.trim()).filter(Boolean);
  for(const item of doc.getElementsByTagName('item')) {
    const title=text(item,'dc:title')[0]||'',key=workKey(title);
    // 曖昧一致の結果が多いので、入力した文字を含むタイトルだけを残す
    if(!key.includes(q)) continue;
    const author=personName(text(item,'dc:creator')[0]),ndc=text(item,'dc:subject').find(x=>/^\d{3}/.test(x))||'';
    const group=`${key}|${workKey(author)}`,found=groups.get(group);
    if(found) { found.hits++; continue; }
    groups.set(group, {
      source:'ndl',kind:ndc.startsWith('726')?'manga':/^9\d3/.test(ndc)?'novel':'book',title,author,year:Number(text(item,'dc:date')[0]?.slice(0,4))||null,
      tags:author?[author]:[],thumb:'',cover:'',hits:1,exact:key===q
    })
  }
  // 完全一致を先に、同じ本の版が多いもの（よく知られた本）を上に
  return[...groups.values()].sort((a,b)=>b.exact-a.exact||b.hits-a.hits).slice(0,5).map(({ hits,exact,...x })=>x)
}
async function searchAniList(query) {
  const r=await fetch(ANILIST, { method:'POST',headers: { 'Content-Type':'application/json',Accept:'application/json' },body:JSON.stringify( { query:ANILIST_QUERY,variables: { q:query } }) });
  if(!r.ok) throw new Error(`AniList ${r.status}`);
  return parseAniList(await r.json())
}
function wikidataApi(params) {
  return fetch(`${WIKIDATA}?${new URLSearchParams( { format:'json',origin:'*',...params })}`).then(r=> {
    if(!r.ok) throw new Error(`Wikidata ${r.status}`);
    return r.json()
  })
}
function parseWikidata(entities,labels= {},kinds=Object.keys(WIKIDATA_KINDS)) {
  const ids=(entity,prop)=>(entity.claims?.[prop]||[]).map(x=>x.mainsnak?.datavalue?.value?.id).filter(Boolean);
  return Object.values(entities||{}).map(entity=> {
    const types=ids(entity,'P31'),title=entity.labels?.ja?.value||'';
    const kind=Object.keys(WIKIDATA_KINDS).find(k=>types.some(t=>WIKIDATA_KINDS[k].includes(t)));
    if(!title||!kinds.includes(kind)||types.some(t=>WIKIDATA_ANIME.includes(t))) return null;
    const time=(entity.claims?.P577||[]).map(x=>x.mainsnak?.datavalue?.value?.time).find(Boolean);
    // 映画・ドラマは監督（なければ脚本）、ゲームは開発元
    const people=kind==='game'?ids(entity,'P178'):ids(entity,'P57').length?ids(entity,'P57'):ids(entity,'P58');
    const name=id=>labels[id]?personName(labels[id]):'';
    const author=people.map(name).find(Boolean)||'';
    // 「テレビドラマシリーズ」「ビデオゲーム」のような、種類を言い直しただけのジャンルは除く
    const genreTags=ids(entity,'P136').map(name).filter(x=>x&&!/^(テレビ)?(ドラマ|映画|ビデオゲーム|ゲーム)(シリーズ)?$/.test(x)).slice(0,3);
    return {
      source:'wikidata',kind,title,author,year:time?Number(time.slice(1,5))||null:null,
      tags:[...new Set([author,...genreTags].filter(Boolean))].slice(0,WORK_TAGS),thumb:'',cover:''
    }
  }).filter(Boolean)
}
async function searchWikidata(query,kinds) {
  const found=await wikidataApi( { action:'wbsearchentities',search:query,language:'ja',uselang:'ja',type:'item',limit:'12' });
  const ids=(found.search||[]).map(x=>x.id);
  if(!ids.length) return[];
  const { entities }=await wikidataApi( { action:'wbgetentities',ids:ids.join('|'),props:'labels|claims',languages:'ja' });
  // 監督・開発元・ジャンルの名前を、まとめて日本語で取る
  const refs=new Set();
  Object.values(entities||{}).forEach(entity=>['P57','P58','P178','P136'].forEach(prop=>(entity.claims?.[prop]||[]).slice(0,3).forEach(x=> { const id=x.mainsnak?.datavalue?.value?.id; if(id) refs.add(id); })));
  const labels= {};
  if(refs.size) {
    try {
      const named=await wikidataApi( { action:'wbgetentities',ids:[...refs].slice(0,50).join('|'),props:'labels',languages:'ja' });
      Object.values(named.entities||{}).forEach(x=> { if(x.labels?.ja) labels[x.id]=x.labels.ja.value; })
    }
    catch {}
  }
  // 検索の並び（関連の強い順）を保つ
  const order=new Map(ids.map((id,i)=>[id,i]));
  return parseWikidata(Object.fromEntries(Object.entries(entities||{}).sort((a,b)=>order.get(a[0])-order.get(b[0]))),labels,kinds).slice(0,6)
}
function parseTmdb(json) {
  return(json?.results||[]).filter(r=>r.media_type==='movie'||r.media_type==='tv').filter(r=> {
    // 日本のアニメは AniList と重なるので除く（海外のアニメーション映画は残す）
    return!((r.genre_ids||[]).includes(16)&&r.original_language==='ja')
  }).map(r=> {
    const movie=r.media_type==='movie',date=(movie?r.release_date:r.first_air_date)||'';
    // ドラマの「ドラマ」は種類の言い直しなので、タグにしない
    const genreTags=[...new Set((r.genre_ids||[]).filter(id=>movie||id!==18).map(id=>TMDB_GENRES[id]).filter(Boolean))].slice(0,3);
    return {
      source:'tmdb',tmdb:`${r.media_type}/${r.id}`,kind:movie?'movie':'drama',title:String((movie?r.title:r.name)||'').trim(),author:'',year:Number(date.slice(0,4))||null,
      tags:genreTags,thumb:r.poster_path?`${TMDB_IMAGE}w92${r.poster_path}`:'',cover:r.poster_path?`${TMDB_IMAGE}w500${r.poster_path}`:''
    }
  }).filter(x=>x.title).slice(0,8)
}
async function searchTmdb(query) {
  const r=await fetch(`${TMDB}/search/multi?${new URLSearchParams( { query,language:'ja-JP',include_adult:'false',api_key:tmdbKey() })}`);
  if(!r.ok) throw new Error(`TMDB ${r.status}`);
  return parseTmdb(await r.json())
}
// 監督（映画）・制作者（ドラマ）は、選んだときに1回だけ問い合わせる
function tmdbPeople(json) {
  const names=json?.created_by?.length?json.created_by.map(x=>x.name):(json?.credits?.crew||[]).filter(x=>x.job==='Director').map(x=>x.name);
  return[...new Set(names.map(personName).filter(Boolean))].slice(0,2)
}
async function fetchTmdbPeople(work) {
  const r=await fetch(`${TMDB}/${work.tmdb}?${new URLSearchParams( { language:'ja-JP',append_to_response:'credits',api_key:tmdbKey() })}`);
  if(!r.ok) throw new Error(`TMDB ${r.status}`);
  return tmdbPeople(await r.json())
}
// Apple Books の作者欄は「山田鐘人 & アベツカサ」「渡真仁, 三嶋くろね & 暁なつめ」のように複数人のことがある
function bookAuthors(name) {
  return String(name||'').split(/\s*(?:,|，|&|＆|、)\s*/).map(personName).filter(Boolean)
}
// 「葬送のフリーレン(15)」「ONE PIECE モノクロ版 115」の巻数を分ける。「1Q84」のような題名の数字は巻数にしない
const BOOK_VOLUME=/(?:\s+|[(（]\s*)([0-9０-９]+)\s*[)）]?\s*$/;
function bookVolume(name) {
  const title=String(name||'').trim(),m=title.match(BOOK_VOLUME);
  return m&&m.index>0?{ base:title.slice(0,m.index).trim(),volume:Number(m[1].normalize('NFKC')) }:{ base:title,volume:0 }
}
function bookCoverUrl(r) {
  return r.artworkUrl100.replace(/\/\d+x\d+bb\./,'/600x600bb.')
}
// 題名が同じ（巻数などの続きは可）で、作者も同じ電子書籍の表紙だけを使う。違う本の表紙を付けないため
// 題名がぴったり同じものを先に、続きものは若い巻（1巻）を選ぶ
function pickBookCover(results,work) {
  const title=workKey(work.title),author=workKey(work.author);
  const rank=r=>workKey(r.trackName)===title?-1:bookVolume(r.trackName).volume||Infinity;
  const hits=(results||[]).filter(r=>r.artworkUrl100&&workKey(r.trackName).startsWith(title)&&(author?bookAuthors(r.artistName).some(a=>workKey(a)===author):workKey(r.trackName)===title));
  hits.sort((a,b)=>rank(a)-rank(b));
  return hits.length?bookCoverUrl(hits[0]):''
}
function appleBookKind(genres) {
  const text=(genres||[]).join('/');
  return /マンガ|コミック/.test(text)?'manga':/ライトノベル/.test(text)?'lightnovel':/小説|文学/.test(text)?'novel':'book'
}
// 本の候補を Apple Books からも出す。国立国会図書館サーチより速く（約0.5秒）、表紙もある。巻ごとの結果は1つにまとめ、若い巻の表紙を使う
function parseAppleBooks(json) {
  const groups=new Map();
  for(const r of json?.results||[]) {
    if(!r.trackName||!r.artworkUrl100||(r.genres||[]).includes('アダルト')) continue;
    const { base,volume }=bookVolume(r.trackName),authors=bookAuthors(r.artistName),key=`${workKey(base)}|${workKey(authors[0])}`,group=groups.get(key);
    if(!group) { groups.set(key, { r,base,volume,authors,count:1 }); continue; }
    group.count++;
    // 巻数のない本（単行本・小説の本体）を優先し、続きものの間では若い巻を使う
    if(group.volume&&(!volume||volume<group.volume)) Object.assign(group, { r,volume })
  }
  return[...groups.values()].slice(0,5).map(({ r,base,authors,count })=>( {
    source:'apple',kind:appleBookKind(r.genres),title:count>1?base:r.trackName.trim(),author:authors[0]||'',year:Number(String(r.releaseDate||'').slice(0,4))||null,
    tags:authors.slice(0,2),thumb:r.artworkUrl100,cover:bookCoverUrl(r)
  }))
}
async function searchAppleBooks(query) {
  const r=await fetch(`${ITUNES}?${new URLSearchParams( { term:query,country:'jp',media:'ebook',limit:'25' })}`);
  if(!r.ok) throw new Error(`iTunes ${r.status}`);
  return parseAppleBooks(await r.json())
}
async function findBookCover(work) {
  const r=await fetch(`${ITUNES}?${new URLSearchParams( { term:[work.title,work.author].filter(Boolean).join(' '),country:'jp',media:'ebook',limit:'10' })}`);
  if(!r.ok) throw new Error(`iTunes ${r.status}`);
  return pickBookCover((await r.json()).results,work)
}
async function searchNdl(query) {
  const r=await fetch(`${NDL}?${new URLSearchParams( { title:query,mediatype:'books',cnt:'100' })}`);
  if(!r.ok) throw new Error(`NDL ${r.status}`);
  return parseNdl(await r.text(),query)
}
const WORK_KIND_NAMES= { anime:'アニメ',manga:'漫画',lightnovel:'ライトノベル',novel:'小説',book:'本',movie:'映画',drama:'ドラマ',game:'ゲーム' };
function closeWorkResults(message='') {
  workSearchId++;
  $('#work-results').hidden=true;
  $('#work-results').replaceChildren();
  $('#work-status').textContent=message
}
function workOption(work) {
  const button=document.createElement('button'),art=document.createElement('span'),info=document.createElement('span'),name=document.createElement('b'),meta=document.createElement('small');
  button.type='button';
  button.className='work-result';
  art.className='work-thumb';
  art.setAttribute('aria-hidden','true');
  if(work.thumb) {
    const img=document.createElement('img');
    img.src=work.thumb;
    img.alt='';
    img.loading='lazy';
    art.append(img)
  }
  else art.textContent=WORK_KIND_NAMES[work.kind].slice(0,1);
  name.textContent=work.title;
  meta.textContent=[WORK_KIND_NAMES[work.kind],work.year,work.author].filter(Boolean).join('・');
  info.append(name,meta);
  button.append(art,info);
  button.onclick=()=>applyWork(work);
  return button
}
// 本の検索は時間がかかるので、先に届いた結果から順に出す
async function runWorkSearch() {
  const query=$('#title').value.trim(),box=$('#work-results');
  closeWorkResults();
  const id=workSearchId;
  if(!query) {
    $('#work-status').textContent='タイトルを入力してから検索してください。';
    $('#title').focus();
    return
  }
  $('#work-status').textContent='検索しています…';
  const searches=tmdbKey()?[searchAniList(query),searchAppleBooks(query),searchTmdb(query),searchWikidata(query,['game']),searchNdl(query)]:[searchAniList(query),searchAppleBooks(query),searchWikidata(query),searchNdl(query)];
  // 同じ作品（題名と作者が同じ）が別の検索先からも届いたら、先に届いた方だけを出す
  const seen=new Set();
  let found=0,failed=0,left=searches.length;
  const status=()=> {
    if(left) return found?`${found}件の候補が見つかりました。ほかの候補も探しています…`:'検索しています…';
    if(failed===searches.length) return'作品を検索できませんでした。通信状況を確かめて、もう一度お試しください。';
    if(!found) return'見つかりませんでした。別の書き方でもお試しください。';
    return`${found}件の候補が見つかりました。選ぶと入力されます。${failed?'（一部の検索に失敗しました）':''}`
  };
  await Promise.all(searches.map(search=>search.then(list=> {
    if(id!==workSearchId) return;
    list.forEach(work=> {
      const key=`${workKey(work.title)}|${workKey(work.author)}`;
      if(seen.has(key)) return;
      seen.add(key);
      box.append(workOption(work));
      found++
    });
    box.hidden=!found
  },()=> { failed++; }).finally(()=> {
    left--;
    if(id===workSearchId) $('#work-status').textContent=status()
  })))
}
async function fetchCover(url) {
  const r=await fetch(url);
  if(!r.ok) throw new Error('表紙画像を取得できませんでした。');
  const blob=await r.blob(),src=URL.createObjectURL(blob);
  try { return await scaleImage(src); }
  finally { URL.revokeObjectURL(src); }
}
async function applyWork(work) {
  $('#title').value=work.title.slice(0,100);
  $('#entryGenre').value=pickGenre(work.kind);
  work.tags.forEach(tag=> { if(!state.formTags.includes(tag)) state.formTags.push(tag.slice(0,80)); });
  dirty=true;
  renderGenreChips();
  renderFormTags();
  closeWorkResults(`「${work.title}」の情報を入力しました。`);
  const token=workSearchId;
  if(work.source==='tmdb') {
    fetchTmdbPeople(work).then(people=> {
      if(token!==workSearchId) return;
      people.forEach(name=> { if(!state.formTags.includes(name)) state.formTags.push(name); });
      renderFormTags()
    }).catch(()=> {})
  }
  // 自分で選んだ表紙は上書きしない。本は、ここで表紙を探す
  if(state.cover||!work.cover&&work.source!=='ndl') return;
  // 取得中に別の記録を開いたり、別の候補を選んだりしたら捨てる（token で見分ける）
  try {
    const url=work.cover||await findBookCover(work);
    if(!url) {
      if(token===workSearchId) $('#work-status').textContent=`「${work.title}」の情報を入力しました（表紙画像は見つかりませんでした）。`;
      return
    }
    const cover=await fetchCover(url);
    if(token===workSearchId&&!state.cover) {
      state.cover=cover;
      preview(cover)
    }
  }
  catch {
    if(token===workSearchId) $('#work-status').textContent=`「${work.title}」の情報を入力しました（表紙画像は取得できませんでした）。`
  }
}
function resetForm() {
  closeWorkResults();
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
  $('#share-one').hidden=!x;
  if(x) {
    $('#id').value=x.id;
    $('#title').value=x.title;
    $('#entryGenre').value=x.genre;
    $('#rating').value=x.rating;
    $('#ratingValue').textContent=Number(x.rating).toFixed(1);
    state.formTags=[...(x.tags||[])];
    renderFormTags();
    $('#notes').value=x.notes||'';
    $('#quote').value=x.quote||'';
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
// 表示テーマ（自動 → ライト → ダーク）
const THEMES=['auto','light','dark'],THEME_NAMES= { auto:'自動',light:'ライト',dark:'ダーク' };
function currentTheme() {
  const value=document.documentElement.getAttribute('data-theme');
  return THEMES.includes(value)?value:'auto'
}
function applyTheme(theme) {
  if(theme==='auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme',theme);
  try { localStorage.setItem('yokattana-theme',theme); }
  catch {}
  const button=$('#theme-toggle');
  button.textContent=`◐ ${THEME_NAMES[theme]}`;
  button.setAttribute('aria-label',`表示テーマ：${THEME_NAMES[theme]}（押すと切り替え）`)
}
$('#theme-toggle').onclick=()=>applyTheme(THEMES[(THEMES.indexOf(currentTheme())+1)%THEMES.length]);
applyTheme(currentTheme());
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
$('#work-search').onclick=runWorkSearch;
// 選んだ文字を「||」で囲む。最後に触ったメモか引用が対象（ボタンを押すと選択は外れるが、範囲は textarea に残る）
let spoilerTarget='#notes';
['#notes','#quote'].forEach(s=>$(s).addEventListener('focus',()=> { spoilerTarget=s; }));
$('#mark-spoiler').onclick=()=> {
  const area=$(spoilerTarget),start=area.selectionStart,end=area.selectionEnd,picked=area.value.slice(start,end);
  if(!picked.trim()) {
    $('#spoiler-hint').textContent='メモか引用で、ネタバレにしたい部分を選んでから押してください。';
    area.focus();
    return
  }
  area.setRangeText(`||${picked}||`,start,end,'select');
  area.dispatchEvent(new Event('input', { bubbles:true }));
  $('#spoiler-hint').textContent='「||」で囲んだ部分は、カードや共有ページで隠れます。';
  area.focus()
};
$('#tmdb-credit').hidden=!tmdbKey();
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
    id:id||crypto.randomUUID(),title:$('#title').value.trim(),genre:$('#entryGenre').value.trim(),rating:Number($('#rating').value),readAt:validDay($('#readAt').value),tags:[...state.formTags],notes:$('#notes').value.trim(),quote:$('#quote').value.trim(),spoiler:hasSpoiler($('#notes').value)||hasSpoiler($('#quote').value),cover:state.cover,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),deleted:false
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
  const header=['タイトル','ジャンル','評価','読んだ日','タグ','メモ','引用','ネタバレ','追加日'];
  const rows=liveItems().sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)).map(x=>[x.title,x.genre,x.rating.toFixed(1),x.readAt||'',x.tags.join(';'),x.notes,x.quote,x.spoiler?'あり':'',localDay(new Date(x.createdAt))]);
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
  quote:['引用','名言','quote'],
  spoiler:['ネタバレ','spoiler'],
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
      tags:cells('tags').join(';').split(/[;；,，、]+/),notes:cells('notes').join('\n\n'),quote:cells('quote')[0],spoiler:/^(1|true|yes|あり|有|○|はい)$/i.test(cells('spoiler')[0]||''),
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
  list.replaceChildren();
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
  list.replaceChildren();
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
  box.replaceChildren();
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
  summary.replaceChildren();
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
  list.replaceChildren();
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
  select.replaceChildren(new Option('すべての期間','all'));
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

// 共有する記録を、手動で選ぶ
function setPicked(id,on) {
  if(on) selection.add(id);
  else selection.delete(id);
  updatePickBar()
}
function pickedItems() {
  // 画面の並び順を保ち、絞り込みで見えていない選択済みの記録は、最後に足す
  const shown=visible().filter(x=>selection.has(x.id)),ids=new Set(shown.map(x=>x.id));
  return[...shown,...liveItems().filter(x=>selection.has(x.id)&&!ids.has(x.id)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))]
}
function updatePickBar() {
  const bar=$('#pick-bar');
  bar.hidden=!picking;
  if(!picking) return;
  const count=selection.size;
  $('#pick-count').textContent=count>SHARE_LIMIT?`${count}件を選択中（共有できるのは${SHARE_LIMIT}件までです）`:`${count}件を選択中`;
  $('#pick-share').disabled=!count||count>SHARE_LIMIT;
  $('#pick-clear').disabled=!count;
  $('#pick-all').textContent=`絞り込み結果をすべて選ぶ（${visible().length}件）`
}
function setPicking(on) {
  picking=on;
  if(!on) selection.clear();
  render()
}
$('#start-pick').onclick=()=> setPicking(true);
$('#pick-cancel').onclick=()=> setPicking(false);
$('#pick-clear').onclick=()=> { selection.clear(); render(); };
$('#pick-all').onclick=()=> { visible().forEach(x=>selection.add(x.id)); render(); };
$('#pick-share').onclick=()=> {
  const items=pickedItems();
  if(items.length) openShare(items,items.length===1?items[0].title:'選んだ記録','手動で選んだ記録')
};
document.addEventListener('keydown',event=> { if(event.key==='Escape'&&picking&&!document.querySelector('dialog[open]')) setPicking(false); });

// 共有リンク（その時点の内容を、読み取り専用のコピーとして公開する）
const SHARE_LIMIT=100,SHARE_TOKEN=/^[A-Za-z0-9_-]{22,64}$/;
let shareDraft= { items:[],criteria:'' };
function makeShareToken() {
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
}
// mode: none = メモ・引用を含めない / safe = ネタバレなしの記録だけ / all = すべて（ネタバレ記録には印を付ける）
function sharePayload(items,{ title,criteria,mode }) {
  return {
    v:2,title:String(title||'').slice(0,100),criteria:String(criteria||'').slice(0,200),sharedAt:new Date().toISOString(),
    items:items.slice(0,SHARE_LIMIT).map(x=> {
      const out= { title:x.title,genre:x.genre,rating:x.rating,readAt:x.readAt||null,tags:[...x.tags] };
      // safe: ネタバレの部分を「（ネタバレのため省略）」にして送る。all: 「||」のまま送り、閲覧ページで隠す
      // 「||」のない古い形（記録全体がネタバレ）でも漏らさないよう、ここでも全体を囲む
      const legacy=x.spoiler&&!hasSpoiler(x.notes)&&!hasSpoiler(x.quote),src=legacy? { notes:wrapSpoiler(x.notes),quote:wrapSpoiler(x.quote) }:x;
      const notes=mode==='safe'?withoutSpoilers(src.notes):src.notes||'',quote=mode==='safe'?withoutSpoilers(src.quote):src.quote||'';
      if(mode!=='none'&&(notes||quote)) { out.notes=notes; out.quote=quote; }
      return out
    })
  }
}
function criteriaText() {
  const parts=[],query=$('#query').value.trim();
  if(query) parts.push(`検索：${query}`);
  if(filters.genre.size) parts.push(`ジャンル：${[...filters.genre].join('、')}`);
  if(filters.tag.size) parts.push(`タグ：${[...filters.tag].join('、')}`);
  return parts.join(' / ')||'すべての記録'
}
function shareUrl(id) {
  return new URL(`share.html#${id}`,location.href).href
}
function legacyCopy(text) {
  const area=document.createElement('textarea');
  area.value=text;
  area.setAttribute('readonly','');
  area.style.position='fixed';
  area.style.opacity='0';
  document.body.append(area);
  area.select();
  let ok=false;
  try { ok=document.execCommand('copy'); }
  catch {}
  area.remove();
  return ok
}
// ボタンの文字を、少しの間だけ変えて、押せたことを伝える
function flashButton(button,label='コピーしました ✓') {
  if(!button) return;
  const original=button.dataset.label||button.textContent;
  button.dataset.label=original;
  button.textContent=label;
  button.classList.add('done');
  clearTimeout(button.flashTimer);
  button.flashTimer=setTimeout(()=> {
    button.textContent=original;
    button.classList.remove('done')
  },2000)
}
async function copyText(text,button) {
  let ok=true;
  try { await navigator.clipboard.writeText(text); }
  catch { ok=legacyCopy(text); }
  if(!ok) { prompt('このリンクをコピーしてください',text); return; }
  flashButton(button);
  showToast('リンクをコピーしました。')
}
function openShare(items,title,criteria) {
  shareDraft= { items,criteria };
  $('#share-title').value=title;
  $('#share-login').hidden=!!currentUser;
  $('#share-create').disabled=!currentUser;
  $('#share-summary').textContent=`共有する記録：${items.length}件（${criteria}）`+(items.length>SHARE_LIMIT?`。共有できるのは${SHARE_LIMIT}件までです。絞り込んでください。`:'');
  $('#share-result').hidden=true;
  $('#share-native').hidden=!navigator.share;
  $('#share-dialog').showModal();
  loadMyShares()
}
async function createShare() {
  if(!currentUser) return;
  const items=shareDraft.items;
  if(!items.length) { alert('共有する記録がありません。'); return; }
  if(items.length>SHARE_LIMIT) { alert(`共有できるのは${SHARE_LIMIT}件までです。絞り込んでください。`); return; }
  const mode=document.querySelector('input[name=share-mode]:checked').value,days=Number($('#share-expiry').value);
  const title=$('#share-title').value.trim()||'共有した記録';
  const row= { id:makeShareToken(),user_id:currentUser.id,title:title.slice(0,100),item_count:items.length,payload:sharePayload(items,{ title,criteria:shareDraft.criteria,mode }),expires_at:days?new Date(Date.now()+days*86400000).toISOString():null };
  try {
    const { error }=await cloud.from('shares').insert(row);
    if(error) throw error
  }
  catch(error) {
    const message=String(error?.message||'');
    alert(/too many/i.test(message)?'作成済みのリンクが多すぎます（50件まで）。不要なリンクを停止してください。':/shares|relation|schema cache|does not exist/i.test(message)?'共有機能がまだ有効になっていません。supabase-schema.sql の shares の部分を、Supabase で実行してください。':'共有リンクを作れませんでした。通信状況を確認して、もう一度お試しください。');
    return
  }
  $('#share-url').value=shareUrl(row.id);
  $('#share-result').hidden=false;
  $('#share-url').select();
  loadMyShares()
}
async function loadMyShares() {
  const list=$('#share-list');
  list.replaceChildren();
  const note=text=> {
    const li=document.createElement('li');
    li.className='manage-empty';
    li.textContent=text;
    list.append(li)
  };
  if(!currentUser) return note('ログインすると、作成済みのリンクが見られます');
  try {
    const { data,error }=await cloud.from('shares').select('id,title,item_count,created_at,expires_at').order('created_at', { ascending:false });
    if(error) throw error;
    if(!data.length) return note('まだありません');
    data.forEach(row=> {
      const li=document.createElement('li'),name=document.createElement('span'),when=document.createElement('small'),copy=document.createElement('button'),stop=document.createElement('button');
      const expired=row.expires_at&&new Date(row.expires_at)<new Date();
      name.className='manage-name';
      name.textContent=`${row.title}（${row.item_count}件）`;
      when.className='trash-days';
      when.textContent=expired?'期限切れ':row.expires_at?`${date(row.expires_at)}まで`:'期限なし';
      copy.type='button';
      copy.className='link';
      copy.textContent='コピー';
      copy.onclick=()=>copyText(shareUrl(row.id),copy);
      stop.type='button';
      stop.className='link danger';
      stop.textContent='停止';
      stop.onclick=()=>stopShare(row);
      li.append(name,when,copy,stop);
      list.append(li)
    })
  }
  catch { note('リンクの一覧を読み込めませんでした'); }
}
async function stopShare(row) {
  if(!confirm(`「${row.title}」の共有を停止します。このリンクでは、見られなくなります。`)) return;
  try {
    const { error }=await cloud.from('shares').delete().eq('id',row.id);
    if(error) throw error
  }
  catch { alert('停止できませんでした。通信状況を確認して、もう一度お試しください。'); return; }
  loadMyShares()
}
$('#open-share').onclick=()=>openShare(visible(),criteriaText()==='すべての記録'?'私のよかった記録':criteriaText(),criteriaText());
$('#share-one').onclick=()=> {
  const item=state.items.find(x=>x.id===$('#id').value);
  if(!item||(dirty&&!confirm(DISCARD_MESSAGE))) return;
  closeEditor(true);
  openShare([item],item.title,`「${item.title}」1件`)
};
$('#share-create').onclick=createShare;
$('#share-copy').onclick=()=>copyText($('#share-url').value,$('#share-copy'));
$('#share-native').onclick=()=> { navigator.share?.({ title:$('#share-title').value||'よかっ棚',url:$('#share-url').value }).catch(()=> {}); };
$('#close-share').onclick=()=>$('#share-dialog').close();

// オフラインでも開けるように、Service Worker を登録する（https のときだけ）
if('serviceWorker' in navigator&&location.protocol==='https:') {
  window.addEventListener('load',()=> { navigator.serviceWorker.register(trusted.createScriptURL('sw.js')).catch(()=> {}); });
}

// 別のタブでの変更を取り込む（編集中は触らない）
window.addEventListener('storage',event=> {
  if(event.key!==KEY||!event.newValue) return;
  state.items=mergeItems(state.items,load());
  if(!$('#dialog').open) render()
});
window.addEventListener('online',()=> { updateSyncStatus(); flushPending(); });
window.addEventListener('offline',()=>updateSyncStatus());
document.addEventListener('visibilitychange',()=> { if(document.visibilityState==='visible') flushPending(); });
setInterval(flushPending,60000);
{
  const next=compactTrash(state.items),changed=next.filter((x,i)=>x!==state.items[i]);
  if(changed.length) commit(next,true)
}
render();
initializeCloud();
shrinkExistingCovers()
