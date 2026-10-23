const KEY='watashi-no-hondana-v1',$=s=>document.querySelector(s);
const cloud=window.supabase?.createClient(window.SUPABASE_CONFIG?.url,window.SUPABASE_CONFIG?.publishableKey);
let currentUser=null;

function setSyncStatus(message,connected=false) {
  const status=$('#sync-status');
  status.textContent=message;
  status.classList.toggle('connected',connected)
}
async function syncItem(item) {
  if(!currentUser) return;
  const { error }=await cloud.from('library_items').upsert({ id:item.id,user_id:currentUser.id,payload:item,updated_at:new Date().toISOString() });
  if(error) setSyncStatus('同期に失敗しました');
  else setSyncStatus('自動同期中',true)
}
async function removeRemoteItem(id) {
  if(!currentUser) return;
  const { error }=await cloud.from('library_items').delete().eq('id',id);
  if(error) setSyncStatus('同期に失敗しました')
}
async function loadCloudItems() {
  const { data,error }=await cloud.from('library_items').select('payload');
  if(error) { setSyncStatus('同期に失敗しました'); return; }
  const merged=new Map(state.items.map(item=>[item.id,item]));
  data.forEach(row=> { const local=merged.get(row.payload.id); if(!local||new Date(row.payload.updatedAt)>new Date(local.updatedAt)) merged.set(row.payload.id,row.payload); });
  state.items=[...merged.values()];
  localStorage.setItem(KEY,JSON.stringify(state.items));
  await Promise.all(state.items.map(syncItem));
  setSyncStatus('自動同期中',true);
  render()
}
async function initializeCloud() {
  if(!cloud) { setSyncStatus('同期設定が見つかりません'); return; }
  const { data }=await cloud.auth.getSession();
  currentUser=data.session?.user||null;
  if(currentUser) { $('#auth-button').textContent='ログアウト'; await loadCloudItems(); }
  else setSyncStatus('ログインすると自動同期')
}
async function toggleAuthentication() {
  if(currentUser) { await cloud.auth.signOut(); currentUser=null; $('#auth-button').textContent='ログイン'; setSyncStatus('ログインすると自動同期'); return; }
  const email=prompt('ログイン用メールアドレスを入力してください');
  if(!email) return;
  const { error }=await cloud.auth.signInWithOtp({ email,options:{ emailRedirectTo:window.location.href } });
  alert(error?'メールを送信できませんでした。':'メールを送りました。届いたリンクをこのブラウザで開いてください。')
}

const state= {
  items:load(),cover:null,formTags:[]
};
function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY))||[]
  }
  catch {
    return[]
  }
}
function save() {
  localStorage.setItem(KEY,JSON.stringify(state.items))
}
function e(v='') {
  return String(v).replace(/[&<>'"]/g,c=>( {
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }
  [c]))
}
function genres() {
  return[...new Set(state.items.map(x=>x.genre))].sort((a,b)=>a.localeCompare(b,'ja'))
}
function alltags() {
  return[...new Set(state.items.flatMap(x=>x.tags||[]))].sort((a,b)=>a.localeCompare(b,'ja'))
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
  let q=$('#query').value.trim().toLocaleLowerCase('ja'),g=$('#genre').value,t=$('#tag').value,s=$('#sort').value,r=state.items.filter(x=> {
    let text=[x.title,x.genre,...x.tags,x.notes||''].join(' ').toLocaleLowerCase('ja');
    return(!q||text.includes(q))&&(!g||x.genre===g)&&(!t||x.tags.includes(t))
  });
  return r.sort((a,b)=>s==='old'?new Date(a.createdAt)-new Date(b.createdAt):s==='high'?b.rating-a.rating||new Date(b.createdAt)-new Date(a.createdAt):s==='low'?a.rating-b.rating||new Date(b.createdAt)-new Date(a.createdAt):s==='title'?a.title.localeCompare(b.title,'ja'):new Date(b.createdAt)-new Date(a.createdAt))
}
function render() {
  choices($('#genre'),genres());
  choices($('#tag'),alltags());
  $('#genreList').innerHTML=genres().map(x=>`<option value="${e(x)}">`).join('');
  $('#count').textContent=state.items.length;
  $('#genres').textContent=genres().length;
  $('#average').textContent=state.items.length?(state.items.reduce((a,x)=>a+Number(x.rating),0)/state.items.length).toFixed(1):'—';
  let list=visible(),grid=$('#grid');
  grid.innerHTML='';
  $('#empty').hidden=state.items.length>0;
  $('#notfound').hidden=state.items.length===0||list.length>0;
  $('#heading').textContent=$('#query').value||$('#genre').value||$('#tag').value?`検索結果 (${list.length})`:`すべての記録 (${state.items.length})`;
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
  $('#preview').innerHTML=v?`<img src="${v}" alt="選択した表紙">`:'表紙画像';
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
$('#cover').onchange=x=> {
  let f=x.target.files[0];
  if(f) {
    let r=new FileReader;
    r.onload=()=> {
      state.cover=r.result;
      preview(state.cover)
    };
    r.readAsDataURL(f)
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
    id:id||crypto.randomUUID(),title:$('#title').value.trim(),genre:$('#entryGenre').value.trim(),rating:Number($('#rating').value),tags:[...state.formTags],notes:$('#notes').value.trim(),cover:state.cover,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()
  };
  state.items=old?state.items.map(x=>x.id===id?entry:x):[...state.items,entry];
  save();
  syncItem(entry);
  close();
  render()
};
$('#delete').onclick=()=> {
  let id=$('#id').value;
  if(id&&confirm('この記録を削除しますか？')) {
    state.items=state.items.filter(x=>x.id!==id);
    save();
    removeRemoteItem(id);
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
      if(confirm(`${a.length}件のデータで現在の記録を置き換えます。よろしいですか？`)) {
        state.items=a;
        save();
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
