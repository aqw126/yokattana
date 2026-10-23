const KEY='watashi-no-hondana-v1',$=s=>document.querySelector(s),state= {
  items:load(),cover:null
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
function tags(v) {
  return[...new Set(v.split(/[,、]/).map(x=>x.trim()).filter(Boolean))]
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
function reset() {
  $('#form').reset();
  $('#id').value='';
  state.cover=null;
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
    $('#tags').value=x.tags.join('、');
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
$('#add').onclick=()=>open();
$('#emptyAdd').onclick=()=>open();
$('#close').onclick=close;
$('#cancel').onclick=close;
$('#rating').oninput=x=>$('#ratingValue').textContent=Number(x.target.value).toFixed(1);
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
    id:id||crypto.randomUUID(),title:$('#title').value.trim(),genre:$('#entryGenre').value.trim(),rating:Number($('#rating').value),tags:tags($('#tags').value),notes:$('#notes').value.trim(),cover:state.cover,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()
  };
  state.items=old?state.items.map(x=>x.id===id?entry:x):[...state.items,entry];
  save();
  close();
  render()
};
$('#delete').onclick=()=> {
  let id=$('#id').value;
  if(id&&confirm('この記録を削除しますか？')) {
    state.items=state.items.filter(x=>x.id!==id);
    save();
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
