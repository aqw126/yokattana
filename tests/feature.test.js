// 引用・ネタバレ・共有・オフライン・テーマ のテスト
const indexHtml = () => fetch('../index.html').then(r => r.text());

test('引用とネタバレ: 正規化され、削除すると消える', () => {
  // 以前の「記録全体がネタバレ」の印は、全体を「||」で囲む形に置き換わる
  const item = normalizeItem({ title: 'a', quote: '  名言  ', spoiler: true });
  eq([item.quote, item.spoiler], ['||名言||', true]);
  eq(normalizeItem({ title: 'a', spoiler: 'yes' }).spoiler, false);
  eq(normalizeItem({ title: 'a', notes: '前半||後半||', spoiler: true }).notes, '前半||後半||');
  eq(normalizeItem({ title: 'a', quote: 'x'.repeat(2000) }).quote.length, 1000);
  const emptied = emptyOf(item, new Date().toISOString());
  eq([emptied.quote, emptied.spoiler, hasContent(emptied)], ['', false, false]);
});

test('引用とネタバレ: カードに引用とバッジが出て、検索にも使える', () => {
  resetApp();
  setItems([make({ title: 'A', quote: '星の||王子||さま', spoiler: true }), make({ title: 'B' })]);
  const cards = [...document.querySelectorAll('#grid article')];
  const shown = cards.find(c => c.querySelector('h3').textContent === 'A');
  eq(shown.querySelector('blockquote').textContent, '星のネタバレさま');
  eq(shown.querySelectorAll('blockquote .spoiler-mask').length, 1);
  assert(!shown.querySelector('.spoiler-badge').hidden, 'badge shown');
  const other = cards.find(c => c.querySelector('h3').textContent === 'B');
  assert(other.querySelector('blockquote').hidden && other.querySelector('.spoiler-badge').hidden, 'hidden when empty');
  $('#query').value = '王子';
  eq(visible().map(x => x.title), ['A']);
});

test('引用とネタバレ: 編集画面から保存できる', () => {
  resetApp();
  openEditor();
  $('#title').value = '新作';
  $('#entryGenre').value = '本';
  $('#quote').value = '一文と||秘密||';
  $('#form').requestSubmit();
  const saved = state.items.find(x => x.title === '新作');
  eq([saved.quote, saved.spoiler], ['一文と||秘密||', true]);
  openEditor(saved);
  eq($('#quote').value, '一文と||秘密||');
  assert(!$('#share-one').hidden, 'share button for existing records');
  openEditor();
  assert($('#share-one').hidden, 'no share button for new records');
  $('#dialog').close();
});

test('CSV: 引用とネタバレも往復する', async () => {
  resetApp();
  setItems([make({ title: 'Q', quote: '引用, "||あり||"', spoiler: true })]);
  let blob;
  const original = URL.createObjectURL;
  URL.createObjectURL = b => { blob = b; return 'blob:test'; };
  try { exportCsv(); } finally { URL.createObjectURL = original; }
  const [back] = csvItems(await blob.text());
  eq([back.quote, back.spoiler], ['引用, "||あり||"', true]);
});

// ---- 共有 ----
const sharable = () => [
  make({ title: '安全', genre: '本', tags: ['x'], notes: '普通の感想', quote: '一文', spoiler: false, cover: 'data:image/png;base64,AAAA' }),
  make({ title: 'ネタバレ有り', genre: '本', tags: ['x', 'y'], notes: '面白かった。||犯人は兄||だった', quote: '結末', spoiler: true }),
  make({ title: '古い印', genre: '本', notes: '黒幕は弟', spoiler: true }),
  make({ title: 'メモなし', genre: '漫画' })
];

test('共有の内容: 「含めない」ではメモも引用も入らない', () => {
  const payload = sharePayload(sharable(), { title: 't', criteria: 'c', mode: 'none' });
  eq(payload.items.some(x => 'notes' in x || 'quote' in x || 'spoiler' in x), false);
  eq(Object.keys(payload.items[0]).sort(), ['genre', 'rating', 'readAt', 'tags', 'title']);
});

test('共有の内容: 「ネタバレの部分を除いて」ではネタバレの部分だけを省く', () => {
  const payload = sharePayload(sharable(), { title: 't', criteria: 'c', mode: 'safe' });
  const byTitle = Object.fromEntries(payload.items.map(x => [x.title, x]));
  eq([byTitle['安全'].notes, byTitle['安全'].quote], ['普通の感想', '一文']);
  eq([byTitle['ネタバレ有り'].notes, byTitle['ネタバレ有り'].quote], ['面白かった。（ネタバレのため省略）だった', '結末']);
  // 「||」のない古い印の記録も、全体が省かれる
  eq(byTitle['古い印'].notes, '（ネタバレのため省略）');
  eq(['犯人', '黒幕'].some(w => JSON.stringify(payload).includes(w)), false);
});

test('共有の内容: 「すべて」では「||」のまま送り、見る側で隠す', () => {
  const payload = sharePayload(sharable(), { title: 't', criteria: 'c', mode: 'all' });
  const byTitle = Object.fromEntries(payload.items.map(x => [x.title, x]));
  eq(byTitle['ネタバレ有り'].notes, '面白かった。||犯人は兄||だった');
  eq(byTitle['古い印'].notes, '||黒幕は弟||');
  eq(payload.v, 2);
});

test('共有の内容: 表紙・ID・メールアドレスを含めず、100件で打ち切る', () => {
  currentUser = { id: 'u1', email: 'secret@example.com' };
  const many = Array.from({ length: 130 }, (_, i) => make({ title: 'T' + i, cover: 'data:image/png;base64,AAAA' }));
  const payload = sharePayload(many, { title: 't', criteria: 'c', mode: 'all' });
  eq(payload.items.length, 100);
  const text = JSON.stringify(payload);
  assert(!text.includes('data:image') && !text.includes('secret@example.com') && !text.includes(many[0].id), 'no private fields');
});

test('共有リンクの文字列: 十分に長く、毎回違う', () => {
  const tokens = new Set(Array.from({ length: 50 }, makeShareToken));
  eq(tokens.size, 50);
  tokens.forEach(t => assert(SHARE_TOKEN.test(t) && t.length >= 22, 'token format ' + t));
});

test('共有の絞り込み条件: 画面の絞り込みを説明文にする', () => {
  resetApp();
  eq(criteriaText(), 'すべての記録');
  filters.genre.add('本');
  filters.tag.add('x');
  $('#query').value = '名作';
  eq(criteriaText(), '検索：名作 / ジャンル：本 / タグ：x');
});

test('共有: ログインしていなければ作れない', () => {
  resetApp();
  setItems(sharable());
  openShare(visible(), 't', 'c');
  assert(!$('#share-login').hidden && $('#share-create').disabled, 'must ask to log in');
  $('#share-dialog').close();
});

test('共有: 作成するとリンクができ、一覧に出て、停止できる', async () => {
  resetApp();
  currentUser = { id: 'u1', email: 'a@example.com' };
  setItems(sharable());
  filters.genre.add('本');
  render();
  openShare(visible(), '本の記録', criteriaText());
  eq($('#share-summary').textContent.includes('3件'), true);
  document.querySelector('input[name=share-mode][value=safe]').checked = true;
  await createShare();
  const [row] = [...fakeCloud.shares.values()];
  eq([row.user_id, row.title, row.item_count], ['u1', '本の記録', 3]);
  assert(SHARE_TOKEN.test(row.id), 'valid token');
  const days = (new Date(row.expires_at) - Date.now()) / 86400000;
  assert(days > 29 && days < 31, 'default expiry is 30 days');
  assert(!JSON.stringify(row.payload).includes('犯人'), 'spoiler text must not be uploaded');
  assert($('#share-url').value.endsWith('share.html#' + row.id), 'url shows the token');
  assert(!$('#share-result').hidden, 'result shown');
  await new Promise(r => setTimeout(r, 0));
  eq($('#share-list li .manage-name').textContent, '本の記録（3件）');
  await stopShare({ id: row.id, title: row.title });
  eq(fakeCloud.shares.size, 0);
  $('#share-dialog').close();
});

test('共有: 期限なしを選ぶと、有効期限を付けない', async () => {
  resetApp();
  currentUser = { id: 'u1' };
  setItems(sharable());
  openShare(visible(), 't', 'c');
  $('#share-expiry').value = '0';
  await createShare();
  eq([...fakeCloud.shares.values()][0].expires_at, null);
  $('#share-dialog').close();
});

test('共有: 作成できなかったときは、理由が分かる', async () => {
  resetApp();
  currentUser = { id: 'u1' };
  setItems(sharable());
  openShare(visible(), 't', 'c');
  fakeCloud.insertError = { message: 'too many shares' };
  await createShare();
  assert(alerts.at(-1).includes('50件'), 'limit message');
  fakeCloud.insertError = { message: 'relation "public.shares" does not exist' };
  await createShare();
  assert(alerts.at(-1).includes('supabase-schema.sql'), 'setup message');
  eq(fakeCloud.shares.size, 0);
  $('#share-dialog').close();
});

test('共有: 100件を超える一覧は作れない', async () => {
  resetApp();
  currentUser = { id: 'u1' };
  setItems(Array.from({ length: 101 }, (_, i) => make({ title: 'T' + i })));
  openShare(visible(), 't', 'c');
  await createShare();
  eq(fakeCloud.shares.size, 0);
  assert(alerts.at(-1).includes('100件'), 'limit message');
  $('#share-dialog').close();
});

// ---- 閲覧ページ（share.js） ----
test('閲覧ページ: 以前の共有（記録全体がネタバレ）は閉じた状態、HTMLは文字として表示', () => {
  const root = document.createElement('div');
  renderShare(root, { payload: { title: '<img src=x onerror=alert(1)>', criteria: '本', sharedAt: new Date().toISOString(), items: [
    { title: '安全', genre: '本', rating: 4, tags: ['a'], notes: '感想', quote: '一文', spoiler: false },
    { title: '<script>x</script>', genre: '本', rating: 5, tags: [], notes: '犯人は…', spoiler: true }
  ] } });
  assert(!root.querySelector('img') && !root.querySelector('script'), 'no injected elements');
  eq(root.querySelector('h1').textContent, '<img src=x onerror=alert(1)>');
  const open = [...root.querySelectorAll('article')].map(a => [a.querySelector('h2').textContent, !!a.querySelector('details')]);
  eq(open, [['安全', false], ['<script>x</script>', true]]);
  const details = root.querySelector('details');
  assert(!details.open && details.textContent.includes('犯人は…'), 'spoiler is inside a closed <details>');
  assert(root.textContent.includes('ネタバレの部分は隠しています'), 'notice');
});

test('閲覧ページ: メモなしの記録には本文の欄が出ない', () => {
  const root = document.createElement('div');
  renderShare(root, { payload: { title: 't', items: [{ title: 'A', genre: '本', rating: 3, tags: [], readAt: '2026-01-02' }] } });
  eq(root.querySelectorAll('.share-body').length, 0);
  assert(root.textContent.includes('2026/1/2') && !root.textContent.includes('読んだ'), 'read date without a verb');
});

// 細かい模様の画像（縮めても小さくなりにくい）
function noisyCover(width = 600, height = 900) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d'), data = g.createImageData(width, height);
  for (let i = 0; i < data.data.length; i++) data.data[i] = (i * 2654435761 >>> 13) & 255;
  g.putImageData(data, 0, 0);
  return c.toDataURL('image/png');
}

test('共有: 「表紙を含める」を選んだときだけ、表紙を小さな WebP にして含める', async () => {
  resetApp();
  currentUser = { id: 'u1' };
  const cover = noisyCover();
  setItems([make({ title: '表紙あり', cover }), make({ title: '表紙なし' })]);
  openShare(visible(), 't', 'c');
  eq($('#share-covers').checked, false);
  await createShare();
  assert(!JSON.stringify([...fakeCloud.shares.values()][0].payload).includes('data:image'), 'no covers unless chosen');
  fakeCloud.shares.clear();
  openShare(visible(), 't', 'c');
  $('#share-covers').checked = true;
  await createShare();
  const items = [...fakeCloud.shares.values()][0].payload.items, withCover = items.find(x => x.title === '表紙あり');
  assert(/^data:image\/webp;base64,/.test(withCover.cover) && withCover.cover.length <= SHARE_COVER_MAX, 'small webp');
  eq(items.find(x => x.title === '表紙なし').cover, undefined);
  openShare(visible(), 't', 'c');
  eq($('#share-covers').checked, false);
  $('#share-dialog').close();
});

test('共有: 100件に表紙を含めても、共有の上限（1MB）に収まる', async () => {
  resetApp();
  const cover = noisyCover();
  const items = Array.from({ length: SHARE_LIMIT }, (_, i) => make({ title: 'T' + i, notes: 'あ'.repeat(500), cover }));
  const payload = await addShareCovers(sharePayload(items, { title: 't', criteria: 'c', mode: 'all' }), items);
  assert(payload.items.every(x => x.cover), 'every item keeps a cover');
  assert(new Blob([JSON.stringify(payload)]).size < 1000000, 'under the 1MB limit');
});

test('閲覧ページ: 表紙は WebP か JPEG の data URL だけを表示し、それ以外は頭文字にする', () => {
  const root = document.createElement('div');
  renderShare(root, { payload: { title: 't', items: [
    { title: '火車', genre: '本', rating: 4.6, tags: [], cover: 'data:image/jpeg;base64,/9j/AAAA' },
    { title: '模倣犯', genre: '本', rating: 4, tags: [], cover: 'data:image/webp;base64,UklGRgAA' },
    { title: '外の画像', genre: '本', rating: 4, tags: [], cover: 'https://evil.example/x.jpg' },
    { title: '図形', genre: '本', rating: 4, tags: [], cover: 'data:image/svg+xml;base64,AAAA' }
  ] } });
  const arts = [...root.querySelectorAll('.share-art')];
  eq(arts.map(a => a.querySelector('img')?.getAttribute('src') || a.textContent), ['data:image/jpeg;base64,/9j/AAAA', 'data:image/webp;base64,UklGRgAA', '外', '図']);
  eq([...root.querySelectorAll('article')].map(a => a.classList.contains('top')), [true, false, false, false]);
  eq(root.querySelector('.share-stars').getAttribute('aria-label'), '評価 4.6');
});

test('閲覧ページ: 共有ページの設定（検索除外・参照元なし・CSP）', async () => {
  const html = await fetch('../share.html').then(r => r.text());
  assert(html.includes('noindex'), 'noindex');
  assert(html.includes('no-referrer'), 'no-referrer');
  assert(/connect-src https:\/\/[a-z0-9]+\.supabase\.co;/.test(html), 'connect-src limited');
  assert(/integrity="sha384-/.test(html), 'SRI');
});

// ---- オフライン ----
test('オフライン: 状態表示に出る', () => {
  resetApp();
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  try {
    updateSyncStatus();
    assert($('#sync-status').textContent.includes('オフライン'), 'offline label');
  }
  finally { delete navigator.onLine; }
  updateSyncStatus();
  assert(!$('#sync-status').textContent.includes('オフライン'), 'back online');
});

test('オフライン: Service Workerの事前保存リストが、すべて実在する', async () => {
  const sw = await fetch('../sw.js').then(r => r.text());
  assert(/const VERSION = '[\w.]+';/.test(sw), 'version line for bump-version.py');
  const list = Function('return ' + sw.match(/const ASSETS = (\[[\s\S]*?\]);/)[1])();
  assert(list.length >= 8, 'asset list');
  for (const asset of list) {
    const res = await fetch('../' + (asset === './' ? '' : asset));
    assert(res.ok, 'missing asset ' + asset);
  }
  const html = await indexHtml();
  assert(html.includes("worker-src 'self'"), 'CSP allows the worker');
  assert(html.includes('manifest.webmanifest'), 'manifest linked');
});

test('オフライン: 保存済みの一覧は、通信なしでも読み込める', async () => {
  resetApp();
  await whenSaved();
  await LocalStore.replaceItems([]);
  setItems([make({ title: 'オフラインでも' })]);
  await whenSaved();
  eq((await LocalStore.loadItems()).map(normalizeItem).map(x => x.title), ['オフラインでも']);
});

// ---- コピーの反応 ----
test('コピー: ボタンの文字が変わり、ダイアログの手前にお知らせが出る', async () => {
  resetApp();
  const written = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { written.push(text); } } });
  try {
    $('#share-dialog').showModal();
    $('#share-url').value = 'https://example.com/share.html#abc';
    const button = $('#share-copy');
    const label = button.textContent;
    await copyText($('#share-url').value, button);
    eq(written, ['https://example.com/share.html#abc']);
    assert(button.textContent.includes('コピーしました') && button.classList.contains('done'), 'button feedback');
    assert($('#share-dialog').contains($('#toast')) && !$('#toast').hidden, 'toast must be inside the open dialog to be visible');
    clearTimeout(button.flashTimer);
    button.textContent = label;
    button.classList.remove('done');
  }
  finally {
    delete navigator.clipboard;
    $('#share-dialog').close();
    document.body.append($('#toast'));
  }
});

test('コピー: クリップボードが使えなくても、別の方法でコピーする', async () => {
  resetApp();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
  const execOriginal = document.execCommand;
  let copied = false;
  document.execCommand = command => { copied = command === 'copy'; return true; };
  try {
    const button = document.createElement('button');
    button.textContent = 'コピー';
    await copyText('リンク', button);
    assert(copied, 'fallback copy used');
    assert(button.textContent.includes('コピーしました'), 'feedback');
    clearTimeout(button.flashTimer);
  }
  finally { delete navigator.clipboard; document.execCommand = execOriginal; }
});

// ---- 手動で選んで共有 ----
const cards = () => [...document.querySelectorAll('#grid article')];
const cardOf = title => cards().find(c => c.querySelector('h3').textContent === title);

test('選んで共有: 選ぶモードでは、選択用のチェックが出て、押しても編集画面は開かない', () => {
  resetApp();
  setItems([make({ title: 'A' }), make({ title: 'B' })]);
  eq(cards().every(c => c.querySelector('.pick').hidden), true);
  $('#start-pick').click();
  assert(picking && !$('#pick-bar').hidden, 'bar shown');
  eq(cards().every(c => !c.querySelector('.pick').hidden), true);
  cardOf('A').querySelector('.open').click();
  assert(!$('#dialog').open, 'editor must not open while picking');
  eq(selection.size, 1);
  assert(cardOf('A').classList.contains('picked'), 'picked style');
  eq($('#pick-count').textContent, '1件を選択中');
  cardOf('A').querySelector('.open').click();
  eq(selection.size, 0);
  setPicking(false);
  cardOf('A').querySelector('.open').click();
  assert($('#dialog').open, 'editor opens again after leaving the mode');
  $('#dialog').close();
});

test('選んで共有: 選んだ記録だけが共有の対象になり、画面の並びを保つ', () => {
  resetApp();
  setItems([make({ title: 'A', createdAt: ago(3) }), make({ title: 'B', createdAt: ago(2) }), make({ title: 'C', createdAt: ago(1) })]);
  $('#start-pick').click();
  cardOf('A').querySelector('.pick-box').click();
  cardOf('C').querySelector('.pick-box').click();
  eq(pickedItems().map(x => x.title), ['C', 'A']);
  currentUser = { id: 'u1' };
  $('#pick-share').click();
  eq(shareDraft.items.map(x => x.title), ['C', 'A']);
  eq(shareDraft.criteria, '手動で選んだ記録');
  assert($('#share-summary').textContent.includes('2件'), 'summary');
  $('#share-dialog').close();
  setPicking(false);
});

test('選んで共有: 絞り込んで選び、絞り込みを変えても選択は残る', () => {
  resetApp();
  setItems([make({ title: 'A', genre: '本' }), make({ title: 'B', genre: '漫画' }), make({ title: 'C', genre: '本' })]);
  $('#start-pick').click();
  filters.genre.add('本');
  render();
  $('#pick-all').click();
  eq(selection.size, 2);
  filters.genre.clear();
  filters.genre.add('漫画');
  render();
  cardOf('B').querySelector('.pick-box').click();
  eq(pickedItems().map(x => x.title).sort(), ['A', 'B', 'C']);
  eq($('#pick-count').textContent, '3件を選択中');
  $('#pick-clear').click();
  eq(selection.size, 0);
  assert($('#pick-share').disabled, 'share disabled with nothing picked');
  setPicking(false);
});

test('選んで共有: 100件を超えると共有できない。やめると選択が消える', () => {
  resetApp();
  setItems(Array.from({ length: 101 }, (_, i) => make({ title: 'T' + i })));
  $('#start-pick').click();
  $('#pick-all').click();
  assert($('#pick-share').disabled && $('#pick-count').textContent.includes('100件まで'), 'limit shown');
  $('#pick-cancel').click();
  eq([picking, selection.size, $('#pick-bar').hidden], [false, 0, true]);
});

test('選んで共有: 削除した記録は選択から外れ、Escでモードを抜ける', () => {
  resetApp();
  const item = make({ title: 'A' });
  setItems([item, make({ title: 'B' })]);
  $('#start-pick').click();
  cardOf('A').querySelector('.pick-box').click();
  setItems(state.items.map(x => x.id === item.id ? { ...x, deleted: true } : x));
  eq(selection.size, 0);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  eq(picking, false);
});

test('選んで共有: 選択用のチェックに、作品名入りの名前がある', () => {
  resetApp();
  setItems([make({ title: '火車' })]);
  eq(cards()[0].querySelector('.pick-box').getAttribute('aria-label'), '火車を共有に含める');
});

// ---- 作品の自動入力 ----
const NDL_XML = `<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.0"><channel>
<item><dc:title>稲荷書店きつね堂</dc:title><dc:creator>蒼月, 海里, 1983-</dc:creator><dc:subject xsi:type="dcndl:NDC10">913.6</dc:subject></item>
<item><dc:title>火車</dc:title><dc:creator>宮部／みゆき</dc:creator><dc:subject xsi:type="dcndl:NDC9">913.6</dc:subject><dc:date>1998</dc:date></item>
<item><dc:title>火車</dc:title><dc:creator>宮部, みゆき, 1960-</dc:creator><dc:date>1992</dc:date></item>
<item><dc:title>火車</dc:title><dc:creator>石倉, 久四郎, 1893-</dc:creator></item>
<item><dc:title>帶我走吧!火車</dc:title></item>
</channel></rss>`;
const ANILIST_JSON = { data: { Page: { media: [
  { type: 'MANGA', format: 'MANGA', title: { native: '葬送のフリーレン', romaji: 'Sousou no Frieren' }, genres: ['Adventure', 'Sci-Fi', 'Unknown'], startDate: { year: 2020 }, coverImage: { large: 'https://s4.anilist.co/l.jpg', medium: 'https://s4.anilist.co/m.jpg' }, staff: { edges: [{ role: 'Art', node: { name: { native: 'アベツカサ' } } }, { role: 'Story', node: { name: { native: '山田鐘人' } } }] }, studios: { nodes: [] } },
  { type: 'ANIME', format: 'TV', title: { native: '葬送のフリーレン' }, genres: ['Drama'], startDate: { year: 2023 }, coverImage: {}, staff: { edges: [] }, studios: { nodes: [{ name: 'MADHOUSE' }] } }
] } } };

function withFetch(handler, fn) {
  const original = window.fetch;
  window.fetch = async (url, options) => handler(String(url), options);
  return Promise.resolve().then(fn).finally(() => { window.fetch = original; });
}

test('自動入力: 国会図書館の結果は、タイトルを含むものだけを、同じ本をまとめて並べる', () => {
  const found = parseNdl(NDL_XML, '火車');
  eq(found.map(x => [x.title, x.author, x.kind]), [['火車', '宮部みゆき', 'novel'], ['火車', '石倉久四郎', 'book'], ['帶我走吧!火車', '', 'book']]);
  eq(found[0].tags, ['宮部みゆき']);
});

test('自動入力: AniList の結果から、種類・作者・ジャンルのタグを作る', () => {
  const [manga, anime] = parseAniList(ANILIST_JSON);
  eq([manga.kind, manga.author, manga.year, manga.tags], ['manga', '山田鐘人', 2020, ['山田鐘人', '冒険', 'SF']]);
  eq([anime.kind, anime.author, anime.cover], ['anime', 'MADHOUSE', '']);
});

test('自動入力: 使っているジャンル名があれば、それを選ぶ', () => {
  resetApp();
  eq(pickGenre('manga'), '漫画');
  setItems([make({ genre: 'マンガ' }), make({ genre: '小説' })]);
  eq([pickGenre('manga'), pickGenre('lightnovel'), pickGenre('anime')], ['マンガ', '小説', 'アニメ']);
});

test('自動入力: 候補を選ぶと、タイトル・ジャンル・タグが入り、既存のタグは残る', async () => {
  resetApp();
  openEditor();
  $('#title').value = 'フリーレン';
  state.formTags = ['好き'];
  await withFetch(url => url.startsWith(ANILIST)
    ? new Response(JSON.stringify(ANILIST_JSON))
    : url.startsWith(NDL) ? new Response('<rss><channel></channel></rss>') : Promise.reject(new Error('no image')), async () => {
    await runWorkSearch();
    const options = [...document.querySelectorAll('#work-results .work-result')];
    eq(options.length, 2);
    assert(!$('#work-results').hidden, 'results shown');
    await applyWork(parseAniList(ANILIST_JSON)[0]);
  });
  eq([$('#title').value, $('#entryGenre').value, state.formTags], ['葬送のフリーレン', '漫画', ['好き', '山田鐘人', '冒険', 'SF']]);
  assert($('#work-results').hidden && dirty, 'closed and dirty');
  assert($('#work-status').textContent.includes('表紙画像は取得できませんでした'), 'cover failure reported');
  $('#dialog').close();
});

test('自動入力: 自分で選んだ表紙は上書きしない', async () => {
  resetApp();
  openEditor();
  state.cover = 'data:image/png;base64,AAAA';
  let fetched = false;
  await withFetch(() => { fetched = true; return new Response(''); }, () => applyWork(parseAniList(ANILIST_JSON)[0]));
  eq([fetched, state.cover], [false, 'data:image/png;base64,AAAA']);
  $('#dialog').close();
});

test('自動入力: 両方の検索に失敗したら、そう伝える', async () => {
  resetApp();
  openEditor();
  $('#title').value = '火車';
  await withFetch(() => Promise.reject(new TypeError('offline')), runWorkSearch);
  assert($('#work-status').textContent.includes('検索できませんでした') && $('#work-results').hidden, 'error shown');
  $('#dialog').close();
});

test('自動入力: CSP で、検索先と表紙の取得先だけを許可している', async () => {
  const csp = (await indexHtml()).match(/Content-Security-Policy" content="([^"]+)"/)[1];
  ['https://graphql.anilist.co', 'https://ndlsearch.ndl.go.jp', 'https://s4.anilist.co', 'https://www.wikidata.org', 'https://itunes.apple.com', 'https://*.mzstatic.com', 'https://api.themoviedb.org', 'https://image.tmdb.org'].forEach(host => assert(csp.includes(host), host));
});

// ---- セキュリティの強化 ----
test('Trusted Types: すべてのページの CSP で、HTML 文字列の差し込みを禁じている', async () => {
  for (const page of ['index.html', 'share.html', 'privacy.html', 'guide.html']) {
    const csp = (await fetch('../' + page).then(r => r.text())).match(/Content-Security-Policy" content="([^"]+)"/)[1];
    assert(csp.includes("require-trusted-types-for 'script'") && csp.includes('trusted-types yokattana'), page);
  }
});

test('Trusted Types: app.js と share.js は innerHTML などを使わない', async () => {
  for (const file of ['app.js', 'share.js', 'theme.js']) {
    const code = await fetch('../' + file).then(r => r.text());
    assert(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/.test(code), file);
  }
});

test('埋め込み対策: iframe の中では中身を隠し、新しい画面で開くリンクだけを出す', async () => {
  const frame = document.createElement('iframe');
  frame.src = '../privacy.html';
  document.body.append(frame);
  try {
    await new Promise(resolve => frame.onload = resolve);
    const doc = frame.contentDocument;
    const link = doc.querySelector('body > a');
    eq([doc.body.children.length, link?.target, link?.textContent], [1, '_top', 'よかっ棚を新しい画面で開く']);
    assert(!doc.querySelector('h1'), 'page content hidden');
  } finally { frame.remove(); }
});

test('Trusted Types: 許可した処理は、XML と sw.js だけを通す', () => {
  eq(trusted.createHTML('<?xml version="1.0"?><rss></rss>').toString(), '<?xml version="1.0"?><rss></rss>');
  let blocked = 0;
  try { trusted.createHTML('<img src=x onerror=alert(1)>'); } catch { blocked++; }
  try { trusted.createScriptURL('https://evil.example/x.js'); } catch { blocked++; }
  eq(blocked, 2);
});

// ---- 映画・ドラマ・ゲーム（Wikidata）と、本の表紙（Apple Books） ----
const wdClaim = (prop, ...ids) => ({ [prop]: ids.map(id => ({ mainsnak: { datavalue: { value: { id } } } })) });
const WD_ENTITIES = {
  Q1: { id: 'Q1', labels: { ja: { value: 'ショーシャンクの空に' } }, claims: { ...wdClaim('P31', 'Q11424'), ...wdClaim('P57', 'Q10'), ...wdClaim('P136', 'Q20', 'Q21'), P577: [{ mainsnak: { datavalue: { value: { time: '+1994-09-10T00:00:00Z' } } } }] } },
  Q2: { id: 'Q2', labels: { ja: { value: '半沢直樹' } }, claims: { ...wdClaim('P31', 'Q5398426'), ...wdClaim('P58', 'Q11'), ...wdClaim('P136', 'Q22') } },
  Q3: { id: 'Q3', labels: { ja: { value: 'ゼルダの伝説 ブレス オブ ザ ワイルド' } }, claims: { ...wdClaim('P31', 'Q7889'), ...wdClaim('P178', 'Q12'), ...wdClaim('P57', 'Q10') } },
  Q4: { id: 'Q4', labels: { ja: { value: '千と千尋の神隠し' } }, claims: wdClaim('P31', 'Q20650540', 'Q29168811') },
  Q5: { id: 'Q5', labels: { ja: { value: '第2シーズン' } }, claims: wdClaim('P31', 'Q3464665') },
  Q6: { id: 'Q6', labels: { en: { value: 'No Japanese' } }, claims: wdClaim('P31', 'Q11424') }
};
const WD_LABELS = { Q10: 'フランク・ダラボン', Q11: '八津, 弘幸', Q12: '任天堂', Q20: 'ドラマ映画', Q21: '刑務所映画', Q22: 'テレビドラマシリーズ' };

test('Wikidata: 映画・ドラマ・ゲームを見分け、アニメ・シーズン・日本語名のないものは除く', () => {
  const found = parseWikidata(WD_ENTITIES, WD_LABELS);
  eq(found.map(x => [x.title, x.kind, x.author, x.year]), [
    ['ショーシャンクの空に', 'movie', 'フランク・ダラボン', 1994],
    ['半沢直樹', 'drama', '八津弘幸', null],
    ['ゼルダの伝説 ブレス オブ ザ ワイルド', 'game', '任天堂', null]
  ]);
  eq(found[0].tags, ['フランク・ダラボン', 'ドラマ映画', '刑務所映画']);
  eq(found[1].tags, ['八津弘幸']);
  eq([pickGenre('movie'), pickGenre('drama'), pickGenre('game')], ['映画', 'ドラマ', 'ゲーム']);
});

test('本の表紙: 題名と作者が合う電子書籍だけを選び、大きな画像にする', () => {
  const results = [
    { trackName: '火車', artistName: '富蘭納瑞.歐康納', artworkUrl100: 'https://is1-ssl.mzstatic.com/a/100x100bb.jpg' },
    { trackName: '火車（新潮文庫）', artistName: '宮部みゆき', artworkUrl100: 'https://is1-ssl.mzstatic.com/b/100x100bb.jpg' }
  ];
  eq(pickBookCover(results, { title: '火車', author: '宮部みゆき' }), 'https://is1-ssl.mzstatic.com/b/600x600bb.jpg');
  eq(pickBookCover(results, { title: '火車', author: '石倉久四郎' }), '');
  eq(pickBookCover(results, { title: '火車', author: '' }), 'https://is1-ssl.mzstatic.com/a/600x600bb.jpg');
  eq(pickBookCover([], { title: '火車', author: '宮部みゆき' }), '');
});

test('本の表紙: 本の候補を選ぶと Apple Books で表紙を探し、なければそう伝える', async () => {
  resetApp();
  openEditor();
  const urls = [];
  await withFetch(url => {
    urls.push(url);
    return url.startsWith(ITUNES) ? new Response(JSON.stringify({ results: [] })) : Promise.reject(new Error('unexpected'));
  }, () => applyWork({ source: 'ndl', kind: 'novel', title: '火車', author: '宮部みゆき', tags: [], cover: '' }));
  eq(urls.length, 1);
  assert(urls[0].includes('media=ebook') && urls[0].includes('country=jp'), urls[0]);
  eq([state.cover, $('#work-status').textContent], [null, '「火車」の情報を入力しました（表紙画像は見つかりませんでした）。']);
  $('#dialog').close();
});

test('Wikidata: 検索から候補を作るまで（名前は2回目の問い合わせでまとめて取る）', async () => {
  const calls = [];
  const found = await withFetch(url => {
    const params = new URL(url).searchParams;
    calls.push(params.get('action') + ':' + (params.get('props') || ''));
    if (params.get('action') === 'wbsearchentities') return new Response(JSON.stringify({ search: [{ id: 'Q3' }, { id: 'Q1' }] }));
    if (params.get('props') === 'labels|claims') return new Response(JSON.stringify({ entities: { Q1: WD_ENTITIES.Q1, Q3: WD_ENTITIES.Q3 } }));
    return new Response(JSON.stringify({ entities: Object.fromEntries(Object.entries(WD_LABELS).map(([id, v]) => [id, { id, labels: { ja: { value: v } } }])) }));
  }, () => searchWikidata('test'));
  eq(calls, ['wbsearchentities:', 'query:', 'wbgetentities:labels|claims', 'wbgetentities:labels']);
  eq(found.map(x => x.title), ['ゼルダの伝説 ブレス オブ ザ ワイルド', 'ショーシャンクの空に']);
});

// ---- TMDB（キーがあるときだけ） ----
const TMDB_JSON = { results: [
  { media_type: 'movie', id: 278, title: 'ショーシャンクの空に', release_date: '1994-09-23', genre_ids: [18, 80], poster_path: '/p1.jpg', original_language: 'en' },
  { media_type: 'tv', id: 61374, name: '半沢直樹', first_air_date: '2013-07-07', genre_ids: [18, 9648], poster_path: null, original_language: 'ja' },
  { media_type: 'movie', id: 129, title: '千と千尋の神隠し', genre_ids: [16, 14], original_language: 'ja' },
  { media_type: 'movie', id: 862, title: 'トイ・ストーリー', genre_ids: [16, 35], original_language: 'en' },
  { media_type: 'person', id: 1, name: '誰か' }
] };
function withTmdbKey(key, fn) {
  const original = window.TMDB_CONFIG;
  window.TMDB_CONFIG = { apiKey: key };
  return Promise.resolve().then(fn).finally(() => { window.TMDB_CONFIG = original; });
}

test('TMDB: 映画・ドラマだけを残し、日本のアニメ（AniList と重なる）と人物は除く', () => {
  const found = parseTmdb(TMDB_JSON);
  eq(found.map(x => [x.title, x.kind, x.year, x.tags]), [
    ['ショーシャンクの空に', 'movie', 1994, ['ドラマ', '犯罪']],
    ['半沢直樹', 'drama', 2013, ['ミステリー']],
    ['トイ・ストーリー', 'movie', null, ['アニメーション', 'コメディ']]
  ]);
  eq([found[0].thumb, found[0].cover], ['https://image.tmdb.org/t/p/w92/p1.jpg', 'https://image.tmdb.org/t/p/w500/p1.jpg']);
  eq([found[1].thumb, found[1].cover], ['', '']);
});

test('TMDB: 監督（映画）と制作者（ドラマ）を取り出す', () => {
  eq(tmdbPeople({ credits: { crew: [{ job: 'Writer', name: 'X' }, { job: 'Director', name: 'Frank Darabont' }] } }), ['Frank Darabont']);
  eq(tmdbPeople({ created_by: [{ name: '福澤, 克雄' }], credits: { crew: [{ job: 'Director', name: 'Y' }] } }), ['福澤克雄']);
});

test('TMDB: キーは32文字の英数字だけを使い、空ならクレジットも出さない', async () => {
  await withTmdbKey('', () => eq(tmdbKey(), ''));
  await withTmdbKey('ここにキー', () => eq(tmdbKey(), ''));
  await withTmdbKey(' 0123456789abcdef0123456789ABCDEF ', () => eq(tmdbKey(), '0123456789abcdef0123456789ABCDEF'));
  assert($('#tmdb-credit').hidden, 'no credit without a key');
});

test('TMDB: キーがあれば映画・ドラマは TMDB で探し、Wikidata はゲームだけにする', async () => {
  resetApp();
  openEditor();
  $('#title').value = 'ショーシャンク';
  const asked = [];
  await withTmdbKey('0123456789abcdef0123456789abcdef', () => withFetch(url => {
    asked.push(url.split('?')[0]);
    if (url.startsWith(TMDB)) return new Response(JSON.stringify(TMDB_JSON));
    if (url.startsWith(WIKIDATA)) {
      const action = new URL(url).searchParams.get('action');
      return new Response(JSON.stringify(action === 'wbsearchentities' ? { search: [{ id: 'Q1' }, { id: 'Q3' }] } : { entities: action && new URL(url).searchParams.get('props') === 'labels|claims' ? { Q1: WD_ENTITIES.Q1, Q3: WD_ENTITIES.Q3 } : {} }));
    }
    return Promise.reject(new Error('offline'));
  }, runWorkSearch));
  assert(asked.includes(`${TMDB}/search/multi`), 'TMDB searched');
  const options = [...document.querySelectorAll('#work-results .work-result small')].map(x => x.textContent);
  eq(options.filter(x => x.startsWith('ゲーム')).length, 1);
  eq(options.filter(x => x.startsWith('映画')).length, 2);
  assert(!options.some(x => x.includes('フランク・ダラボン')), 'no Wikidata movie when TMDB is on');
  $('#dialog').close();
});

// ---- 本の表紙の改善（複数の作者・巻数・Apple Books の候補） ----
const apple = (trackName, artistName, genres, extra = {}) => ({ trackName, artistName, genres, artworkUrl100: `https://is1-ssl.mzstatic.com/${encodeURIComponent(trackName)}/100x100bb.jpg`, releaseDate: '2020-01-01T00:00:00Z', ...extra });

test('本の表紙: 作者が複数の電子書籍（漫画など）も、作者の1人が合えば選ぶ', () => {
  eq(bookAuthors('渡真仁, 三嶋くろね & 暁なつめ'), ['渡真仁', '三嶋くろね', '暁なつめ']);
  const results = [apple('葬送のフリーレン(15)', '山田鐘人 & アベツカサ', []), apple('葬送のフリーレン(1)', '山田鐘人 & アベツカサ', [])];
  eq(pickBookCover(results, { title: '葬送のフリーレン', author: '山田鐘人' }), bookCoverUrl(results[1]));
});

test('本の表紙: 題名が同じものを先に、続きものは1巻を選ぶ。「1Q84」の数字は巻数にしない', () => {
  eq(bookVolume('葬送のフリーレン(15)'), { base: '葬送のフリーレン', volume: 15 });
  eq(bookVolume('ONE PIECE モノクロ版 115'), { base: 'ONE PIECE モノクロ版', volume: 115 });
  eq(bookVolume('ブルーピリオド（１２）'), { base: 'ブルーピリオド', volume: 12 });
  eq(bookVolume('1Q84'), { base: '1Q84', volume: 0 });
  const results = [apple('ONE PIECE モノクロ版 115', '尾田栄一郎', []), apple('ONE PIECE カラー版 1', '尾田栄一郎', []), apple('ONE PIECE', '尾田栄一郎', [])];
  eq(pickBookCover(results, { title: 'ONE PIECE', author: '尾田栄一郎' }), bookCoverUrl(results[2]));
  eq(pickBookCover(results.slice(0, 2), { title: 'ONE PIECE', author: '尾田栄一郎' }), bookCoverUrl(results[1]));
});

test('Apple Books: 巻ごとの結果を1作品にまとめ、種類を見分け、成人向けは除く', () => {
  const found = parseAppleBooks({ results: [
    apple('葬送のフリーレン(15)', '山田鐘人 & アベツカサ', ['ファンタジー', 'マンガ／グラフィックノベル'], { releaseDate: '2025-01-01T00:00:00Z' }),
    apple('葬送のフリーレン(1)', '山田鐘人 & アベツカサ', ['少年', 'マンガ／グラフィックノベル'], { releaseDate: '2020-08-18T00:00:00Z' }),
    apple('火花', '又吉直樹', ['小説／文学', 'ブック']),
    apple('ソードアート・オンライン1 アインクラッド', '川原礫 & abec', ['ライトノベル', '小説／文学']),
    apple('火花の夜に', '誰か', ['アダルト', '小説／文学']),
    apple('写真集', '誰か', ['アート'])
  ] });
  eq(found.map(x => [x.title, x.kind, x.author, x.year]), [
    ['葬送のフリーレン', 'manga', '山田鐘人', 2020],
    ['火花', 'novel', '又吉直樹', 2020],
    ['ソードアート・オンライン1 アインクラッド', 'lightnovel', '川原礫', 2020],
    ['写真集', 'book', '誰か', 2020]
  ]);
  eq(found[0].cover, 'https://is1-ssl.mzstatic.com/' + encodeURIComponent('葬送のフリーレン(1)') + '/600x600bb.jpg');
  eq(found[0].tags, ['山田鐘人', 'アベツカサ']);
});

test('作品の検索: 同じ作品が別の検索先からも届いたら、1つだけ出す', async () => {
  resetApp();
  openEditor();
  $('#title').value = 'フリーレン';
  await withFetch(url => {
    if (url.startsWith(ANILIST)) return new Response(JSON.stringify(ANILIST_JSON));
    if (url.startsWith(ITUNES)) return new Response(JSON.stringify({ results: [apple('葬送のフリーレン(1)', '山田鐘人 & アベツカサ', ['マンガ']), apple('葬送のフリーレン(2)', '山田鐘人 & アベツカサ', ['マンガ']), apple('葬送のフリーレン 公式ファンブック', '山田鐘人', ['マンガ'])] }));
    return Promise.reject(new Error('offline'));
  }, runWorkSearch);
  const titles = [...document.querySelectorAll('#work-results .work-result b')].map(x => x.textContent);
  eq(titles.filter(x => x === '葬送のフリーレン').length, 2);
  assert(titles.includes('葬送のフリーレン 公式ファンブック'), titles.join(','));
  $('#dialog').close();
});

test('Apple Books: 巻数のない本（小説の本体）を、同じ題名の漫画版の巻より優先する', () => {
  const found = parseAppleBooks({ results: [
    apple('かがみの孤城 2', '辻村深月 & 武富智', ['マンガ']),
    apple('かがみの孤城', '辻村深月', ['小説／文学'])
  ] });
  eq(found.map(x => [x.title, x.kind]), [['かがみの孤城', 'novel']]);
});

test('CSP: 候補の小さな表紙を出す画像サーバー（AniList・TMDB・Apple）を、画像の表示にも許可している', async () => {
  const csp = (await indexHtml()).match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const img = csp.split(';').find(x => x.trim().startsWith('img-src'));
  ['https://s4.anilist.co', 'https://image.tmdb.org', 'https://*.mzstatic.com'].forEach(host => assert(img.includes(host), host));
});

// ---- メモの一部をネタバレにする ----
test('ネタバレの部分: 「||」で囲んだ部分だけを分け、閉じていない「||」は文字のまま', () => {
  eq(spoilerParts('前||A||中||B||後'), [{ text: '前', spoiler: false }, { text: 'A', spoiler: true }, { text: '中', spoiler: false }, { text: 'B', spoiler: true }, { text: '後', spoiler: false }]);
  eq(spoilerParts('a || b'), [{ text: 'a || b', spoiler: false }]);
  eq(spoilerParts('||複数\n行||'), [{ text: '複数\n行', spoiler: true }]);
  eq([hasSpoiler('x||y||'), hasSpoiler('x||y'), hasSpoiler('')], [true, false, false]);
  eq(withoutSpoilers('A||B||C'), 'A（ネタバレのため省略）C');
});

test('ネタバレの部分: 選んだ文字をボタンで「||」で囲む。何も選ばずに押すと案内する', () => {
  resetApp();
  openEditor();
  const notes = $('#notes');
  notes.value = '最後に犯人は兄だと分かる';
  notes.focus();
  notes.setSelectionRange(3, 7);
  $('#mark-spoiler').click();
  eq(notes.value, '最後に||犯人は兄||だと分かる');
  assert(dirty, 'marks the form as changed');
  notes.setSelectionRange(0, 0);
  $('#mark-spoiler').click();
  eq(notes.value, '最後に||犯人は兄||だと分かる');
  assert($('#spoiler-hint').textContent.includes('選んでから'), 'hint shown');
  const quote = $('#quote');
  quote.value = '名言';
  quote.focus();
  // 画面に入力の焦点がないとき（裏で開いたテストなど）は focus が届かないので、ここで送る
  quote.dispatchEvent(new FocusEvent('focus'));
  quote.setSelectionRange(0, 2);
  $('#mark-spoiler').click();
  eq(quote.value, '||名言||');
  $('#dialog').close();
});

test('ネタバレの部分: 閲覧ページでは部分ごとに隠し、押すとその部分だけ出る', () => {
  const root = document.createElement('div');
  renderShare(root, { payload: { title: 't', items: [{ title: 'A', genre: '本', rating: 4, tags: [], notes: '前半||<b>秘密</b>||後半' }] } });
  const button = root.querySelector('.spoiler-reveal');
  assert(button && !root.textContent.includes('秘密'), 'hidden at first');
  assert(!root.querySelector('details'), 'not the old closed box');
  button.click();
  eq(root.querySelector('.share-body p').textContent, '前半<b>秘密</b>後半');
  assert(!root.querySelector('.share-body b'), 'shown as text, not HTML');
});

test('ネタバレの部分: 重ねて選ぶと、隠れていた文字を見せずに1つにまとめ、内側だけを選ぶと解除する', () => {
  const t = '最後に||犯人は兄||だと分かる';
  const at = (text, from, to) => { const s = text.indexOf(from); return [s, to ? text.indexOf(to) + to.length : s + from.length]; };
  // 内側だけ（記号を含めても）→ 解除
  eq(toggleSpoiler(t, ...at(t, '犯人は兄')).value, '最後に犯人は兄だと分かる');
  eq(toggleSpoiler(t, ...at(t, '人は')).value, '最後に犯人は兄だと分かる');
  eq(toggleSpoiler(t, ...at(t, '||犯人は兄||')).value, '最後に犯人は兄だと分かる');
  // 端をまたぐ → まとめる（「兄」が見えるようにならない）
  const merged = toggleSpoiler(t, ...at(t, '兄||だと')).value;
  eq(merged, '最後に||犯人は兄だと||分かる');
  eq(spoilerParts(merged).filter(p => p.spoiler).map(p => p.text), ['犯人は兄だと']);
  // 2つにまたがる → 1つに
  eq(toggleSpoiler('||A||と||B||', ...at('||A||と||B||', 'A', 'B')).value, '||AとB||');
  // ふつうの文字 → 囲む
  eq(toggleSpoiler('abc', 1, 2).value, 'a||b||c');
});

test('ネタバレの部分: ボタンをもう一度押すと解除できる', () => {
  resetApp();
  openEditor();
  const notes = $('#notes');
  notes.value = '最後に犯人は兄だと分かる';
  notes.focus();
  notes.setSelectionRange(3, 7);
  $('#mark-spoiler').click();
  eq(notes.value, '最後に||犯人は兄||だと分かる');
  $('#mark-spoiler').click();
  eq(notes.value, '最後に犯人は兄だと分かる');
  assert($('#spoiler-hint').textContent.includes('解除しました'), 'says it was removed');
  $('#dialog').close();
});

// ---- 評価で絞り込む ----
test('評価の絞り込み: 0.5刻みの帯に分ける（境目と小数の誤差）', () => {
  eq([5, 4.5, 4.4, 4.0, 3.9, 3.5, 3.4, 3.0, 4.1 + 0.3].map(ratingBand), ['4.5', '4.5', '4.0', '4.0', '3.5', '3.5', '3.0', '3.0', '4.0']);
});

test('評価の絞り込み: 選んだ帯だけを出し、ほかの絞り込みや並べ替えと組み合わせられる', () => {
  resetApp();
  setItems([
    make({ title: '傑作', genre: '本', rating: 4.8 }),
    make({ title: '良作A', genre: '本', rating: 4.2, readAt: '2026-01-01' }),
    make({ title: '良作B', genre: '漫画', rating: 4.0, readAt: '2026-03-01' }),
    make({ title: 'ふつう', genre: '本', rating: 3.6 })
  ]);
  const boxes = () => [...document.querySelectorAll('#rating-filter .multi-panel label')].map(l => l.textContent);
  eq(boxes(), ['★4.5〜5.0（1件）', '★4.0〜4.4（2件）', '★3.5〜3.9（1件）', '★3.0〜3.4（0件）']);
  document.querySelector('#rating-filter input[value="4.0"]').click();
  $('#sort').value = 'read';
  eq(visible().map(x => x.title), ['良作B', '良作A']);
  eq($('#rating-filter .multi-value').textContent, '★4.0〜4.4');
  assert($('#heading').textContent.startsWith('検索結果 (2)'), $('#heading').textContent);
  filters.genre.add('本');
  eq(visible().map(x => x.title), ['良作A']);
  eq(criteriaText(), 'ジャンル：本 / 評価：★4.0〜4.4');
  document.querySelector('#rating-filter input[value="4.5"]').click();
  eq(visible().map(x => x.title).sort(), ['傑作', '良作A']);
  eq($('#rating-filter .multi-value').textContent, '★4.5〜5.0、★4.0〜4.4');
  document.querySelector('#rating-filter .multi-clear').click();
  eq(filters.rating.size, 0);
  $('#sort').value = 'new';
});

test('評価の絞り込み: 件数は記録を変えると更新され、選んだ帯は残る', () => {
  resetApp();
  setItems([make({ rating: 4.2 })]);
  document.querySelector('#rating-filter input[value="4.0"]').click();
  setItems([...state.items, make({ rating: 4.3 })]);
  eq(document.querySelector('#rating-filter input[value="4.0"]').parentElement.textContent, '★4.0〜4.4（2件）');
  assert(document.querySelector('#rating-filter input[value="4.0"]').checked, 'still selected');
});

test('編集を開いても、題名に入力欄を合わせない（スマホでキーボードが出ないように）', () => {
  resetApp();
  setItems([make({ title: '火車' })]);
  openEditor();
  eq(document.activeElement.id, 'title');
  closeEditor(true);
  openEditor(state.items[0]);
  assert(document.activeElement.id !== 'title' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName), 'no text field focused');
  closeEditor(true);
});

test('評価のつまみには、入力欄の余白を付けない（3.0・5.0 で端まで届く）', () => {
  const cs = getComputedStyle($('#rating'));
  eq([cs.paddingLeft, cs.paddingRight, cs.borderLeftWidth], ['0px', '0px', '0px']);
});

// ---- ゲーム（検索の改善、Steam の画像、App Store） ----
test('ゲーム: ジャンルは短い名前だけにし、RPG はまとめる', () => {
  eq(['コンピュータRPG', 'アクションロールプレイングゲーム', 'サイバーパンクコンピュータゲーム', '性的少数者が登場するコンピュータゲーム', '文明崩壊後の世界が描かれたコンピュータゲーム', '育成シミュレーションゲーム', 'ビデオゲーム'].map(gameGenre),
    ['RPG', 'アクションRPG', 'サイバーパンク', '', '', '育成シミュレーションゲーム', '']);
});

test('ゲーム: 英語の名前だけのゲームも出し、Steam の番号があれば縦長の画像（なければ横長）を使う', () => {
  const entities = {
    Q7: { id: 'Q7', labels: { en: { value: 'Elden Ring' } }, claims: { ...wdClaim('P31', 'Q7889'), ...wdClaim('P136', 'Q30'), P1733: [{ mainsnak: { datavalue: { value: '1245620' } } }] } },
    Q8: { id: 'Q8', labels: { en: { value: 'Hades' } }, claims: { ...wdClaim('P31', 'Q7889'), P1733: [{ mainsnak: { datavalue: { value: '../x' } } }] } },
    Q9: { id: 'Q9', labels: { en: { value: 'English Movie' } }, claims: wdClaim('P31', 'Q11424') }
  };
  const found = parseWikidata(entities, { Q30: 'コンピュータRPG' }, undefined, { Q7: 'エルデンリング' });
  eq(found.map(x => [x.title, x.tags, x.cover]), [
    ['エルデンリング', ['RPG'], `${STEAM_IMAGE}1245620/library_600x900.jpg`],
    ['Hades', [], '']
  ]);
  eq(found[0].covers, [`${STEAM_IMAGE}1245620/header.jpg`]);
});

test('ゲーム: 縦長の画像が取れなければ、横長の画像を表紙にする', async () => {
  resetApp();
  openEditor();
  const asked = [];
  await withFetch(url => {
    asked.push(url);
    if (url.endsWith('library_600x900.jpg')) return new Response('', { status: 404 });
    return new Response(dataUrlToBlob(noisyCover(60, 40)));
  }, () => applyWork({ source: 'wikidata', kind: 'game', title: 'Old Game', author: '', tags: [], cover: `${STEAM_IMAGE}1/library_600x900.jpg`, covers: [`${STEAM_IMAGE}1/header.jpg`] }));
  eq(asked, [`${STEAM_IMAGE}1/library_600x900.jpg`, `${STEAM_IMAGE}1/header.jpg`]);
  assert(state.cover, 'cover from the fallback image');
  $('#dialog').close();
});

test('App Store: ゲームで、題名が探した言葉で始まるものだけを出し、大きなアイコンを表紙にする', () => {
  const found = parseAppStore({ results: [
    { trackName: '原神-6周年', artistName: 'COGNOSPHERE PTE. LTD.', genreIds: ['6014', '7014', '6016'], genres: ['ゲーム', 'ロールプレイング', 'エンターテインメント'], artworkUrl100: 'https://is1-ssl.mzstatic.com/a/100x100bb.jpg', artworkUrl512: 'https://is1-ssl.mzstatic.com/a/512x512bb.jpg', releaseDate: '2020-09-28T00:00:00Z' },
    { trackName: '原神 攻略マップ', artistName: '誰か', genreIds: ['6002'], genres: ['ユーティリティ'], artworkUrl100: 'https://is1-ssl.mzstatic.com/b/100x100bb.jpg' },
    { trackName: 'まったく別のゲーム', artistName: '誰か', genreIds: ['6014'], genres: ['ゲーム'], artworkUrl100: 'https://is1-ssl.mzstatic.com/c/100x100bb.jpg' },
    { trackName: '[777Real]パチスロ原神', artistName: '誰か', genreIds: ['6014'], genres: ['ゲーム'], artworkUrl100: 'https://is1-ssl.mzstatic.com/d/100x100bb.jpg' }
  ] }, '原神');
  eq(found.map(x => [x.source, x.kind, x.title, x.year, x.tags, x.cover]), [
    ['appstore', 'game', '原神', 2020, ['COGNOSPHERE PTE. LTD.', 'ロールプレイング'], 'https://is1-ssl.mzstatic.com/a/600x600bb.jpg']
  ]);
});

test('ゲーム: CSP で Steam の画像の取得先を許可している', async () => {
  const csp = (await indexHtml()).match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert(/img-src[^;]*https:\/\/shared\.akamai\.steamstatic\.com/.test(csp) && /connect-src[^;]*https:\/\/shared\.akamai\.steamstatic\.com/.test(csp), 'steam allowed');
});

test('ゲーム: Steam にない元のゲームは、同じ開発元の完全版の Steam の番号を借りる（別の会社の外伝は使わない）', async () => {
  const steam = id => [{ mainsnak: { datavalue: { value: id } } }];
  const entities = {
    Q15225985: { id: 'Q15225985', labels: { ja: { value: 'ペルソナ5' } }, claims: { ...wdClaim('P31', 'Q7889'), ...wdClaim('P178', 'Q100'), ...wdClaim('P4969', 'Q74109258', 'Q63385672') } }
  };
  const derived = {
    Q74109258: { id: 'Q74109258', claims: { ...wdClaim('P31', 'Q7889'), ...wdClaim('P178', 'Q200'), ...wdClaim('P144', 'Q15225985'), P1733: steam('1382330') } },
    Q63385672: { id: 'Q63385672', claims: { ...wdClaim('P31', 'Q7889'), ...wdClaim('P178', 'Q100'), ...wdClaim('P144', 'Q15225985'), P1733: steam('1687950') } }
  };
  await withFetch(url => new Response(JSON.stringify({ entities: derived })), () => borrowSteamIds(entities));
  eq(parseWikidata(entities)[0].cover, `${STEAM_IMAGE}1687950/library_600x900.jpg`);
  const alone = { Q1: { id: 'Q1', labels: { ja: { value: 'X' } }, claims: { ...wdClaim('P31', 'Q7889'), ...wdClaim('P178', 'Q100'), ...wdClaim('P4969', 'Q74109258') } } };
  await withFetch(url => new Response(JSON.stringify({ entities: derived })), () => borrowSteamIds(alone));
  eq(parseWikidata(alone)[0].cover, '');
});

test('表紙: 長辺450px の WebP で保存し、WebP を書き出せないブラウザでは JPEG にする', async () => {
  const url = await scaleImage(noisyCover(600, 900));
  const img = await new Promise(resolve => { const i = new Image(); i.onload = () => resolve(i); i.src = url; });
  eq([url.slice(0, 15), Math.max(img.width, img.height)], ['data:image/webp', 450]);
  assert(url.length <= COVER_LIMIT, 'within the limit');
  const c = document.createElement('canvas');
  c.width = c.height = 4;
  assert(encodeCanvas(c, 0.7, false).startsWith('data:image/jpeg'), 'jpeg fallback');
});
