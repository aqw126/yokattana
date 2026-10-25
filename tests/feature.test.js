// 引用・ネタバレ・共有・オフライン・テーマ のテスト
const indexHtml = () => fetch('../index.html').then(r => r.text());

test('引用とネタバレ: 正規化され、削除すると消える', () => {
  const item = normalizeItem({ title: 'a', quote: '  名言  ', spoiler: true });
  eq([item.quote, item.spoiler], ['名言', true]);
  eq(normalizeItem({ title: 'a', spoiler: 'yes' }).spoiler, false);
  eq(normalizeItem({ title: 'a', quote: 'x'.repeat(2000) }).quote.length, 1000);
  const emptied = emptyOf(item, new Date().toISOString());
  eq([emptied.quote, emptied.spoiler, hasContent(emptied)], ['', false, false]);
});

test('引用とネタバレ: カードに引用とバッジが出て、検索にも使える', () => {
  resetApp();
  setItems([make({ title: 'A', quote: '星の王子さま', spoiler: true }), make({ title: 'B' })]);
  const cards = [...document.querySelectorAll('#grid article')];
  const shown = cards.find(c => c.querySelector('h3').textContent === 'A');
  eq(shown.querySelector('blockquote').textContent, '星の王子さま');
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
  $('#quote').value = '一文';
  $('#spoiler').checked = true;
  $('#form').requestSubmit();
  const saved = state.items.find(x => x.title === '新作');
  eq([saved.quote, saved.spoiler], ['一文', true]);
  openEditor(saved);
  eq([$('#quote').value, $('#spoiler').checked], ['一文', true]);
  assert(!$('#share-one').hidden, 'share button for existing records');
  openEditor();
  assert($('#share-one').hidden, 'no share button for new records');
  $('#dialog').close();
});

test('CSV: 引用とネタバレも往復する', async () => {
  resetApp();
  setItems([make({ title: 'Q', quote: '引用, "あり"', spoiler: true })]);
  let blob;
  const original = URL.createObjectURL;
  URL.createObjectURL = b => { blob = b; return 'blob:test'; };
  try { exportCsv(); } finally { URL.createObjectURL = original; }
  const [back] = csvItems(await blob.text());
  eq([back.quote, back.spoiler], ['引用, "あり"', true]);
});

// ---- 共有 ----
const sharable = () => [
  make({ title: '安全', genre: '本', tags: ['x'], notes: '普通の感想', quote: '一文', spoiler: false, cover: 'data:image/png;base64,AAAA' }),
  make({ title: 'ネタバレ有り', genre: '本', tags: ['x', 'y'], notes: '犯人は…', quote: '結末', spoiler: true }),
  make({ title: 'メモなし', genre: '漫画' })
];

test('共有の内容: 「含めない」ではメモも引用も入らない', () => {
  const payload = sharePayload(sharable(), { title: 't', criteria: 'c', mode: 'none' });
  eq(payload.items.some(x => 'notes' in x || 'quote' in x || 'spoiler' in x), false);
  eq(Object.keys(payload.items[0]).sort(), ['genre', 'rating', 'readAt', 'tags', 'title']);
});

test('共有の内容: 「ネタバレなしだけ」ではネタバレ記録の本文を入れない', () => {
  const payload = sharePayload(sharable(), { title: 't', criteria: 'c', mode: 'safe' });
  const byTitle = Object.fromEntries(payload.items.map(x => [x.title, x]));
  eq([byTitle['安全'].notes, byTitle['安全'].quote], ['普通の感想', '一文']);
  eq('notes' in byTitle['ネタバレ有り'], false);
  eq(JSON.stringify(payload).includes('犯人'), false);
});

test('共有の内容: 「すべて」ではネタバレ記録に印を付ける', () => {
  const payload = sharePayload(sharable(), { title: 't', criteria: 'c', mode: 'all' });
  const spoiler = payload.items.find(x => x.title === 'ネタバレ有り');
  eq([spoiler.notes, spoiler.spoiler], ['犯人は…', true]);
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
  eq($('#share-summary').textContent.includes('2件'), true);
  document.querySelector('input[name=share-mode][value=safe]').checked = true;
  await createShare();
  const [row] = [...fakeCloud.shares.values()];
  eq([row.user_id, row.title, row.item_count], ['u1', '本の記録', 2]);
  assert(SHARE_TOKEN.test(row.id), 'valid token');
  const days = (new Date(row.expires_at) - Date.now()) / 86400000;
  assert(days > 29 && days < 31, 'default expiry is 30 days');
  assert(!JSON.stringify(row.payload).includes('犯人'), 'spoiler text must not be uploaded');
  assert($('#share-url').value.endsWith('share.html#' + row.id), 'url shows the token');
  assert(!$('#share-result').hidden, 'result shown');
  await new Promise(r => setTimeout(r, 0));
  eq($('#share-list li .manage-name').textContent, '本の記録（2件）');
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
test('閲覧ページ: ネタバレは閉じた状態、HTMLは文字として表示', () => {
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
  assert(root.textContent.includes('ネタバレを含む部分は、閉じた状態'), 'notice');
});

test('閲覧ページ: メモなしの記録には本文の欄が出ない', () => {
  const root = document.createElement('div');
  renderShare(root, { payload: { title: 't', items: [{ title: 'A', genre: '本', rating: 3, tags: [], readAt: '2026-01-02' }] } });
  eq(root.querySelectorAll('.share-body').length, 0);
  assert(root.textContent.includes('2026/1/2 に読んだ'), 'read date');
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

test('オフライン: 保存済みの一覧は、通信なしでも読み込める', () => {
  resetApp();
  setItems([make({ title: 'オフラインでも' })]);
  const reloaded = load();
  eq(reloaded.map(x => x.title), ['オフラインでも']);
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
  ['https://graphql.anilist.co', 'https://ndlsearch.ndl.go.jp', 'https://s4.anilist.co'].forEach(host => assert(csp.includes(host), host));
});
