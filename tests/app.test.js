// app.js の動作テスト（app.js のグローバルを、そのまま使う）
const DAY = 86400000;
const ago = days => new Date(Date.now() - days * DAY).toISOString();
const uid = () => crypto.randomUUID();
const make = (overrides = {}) => ({
  id: uid(), title: '作品', genre: '本', rating: 4, tags: [], notes: '', cover: null, readAt: null,
  createdAt: ago(10), updatedAt: ago(10), deleted: false, ...overrides
});
const titles = () => [...document.querySelectorAll('#grid h3')].map(h => h.textContent);
const originalAlert = window.alert, originalConfirm = window.confirm, originalPrompt = window.prompt;
const originalClick = HTMLAnchorElement.prototype.click;
let alerts = [];

function resetApp() {
  localStorage.clear();
  pending.clear();
  currentUser = null;
  fakeCloud.reset();
  filters.genre.clear();
  filters.tag.clear();
  $('#query').value = '';
  $('#sort').value = 'new';
  state.items = [];
  alerts = [];
  window.alert = message => alerts.push(String(message));
  window.confirm = () => true;
  window.prompt = () => null;
  HTMLAnchorElement.prototype.click = function () {};
  render();
}

function setItems(items) {
  state.items = items;
  save();
  render();
}

// ---- 記録の正規化 ----
test('normalizeItem: 不正なIDは作り直し、正しいIDは保つ', () => {
  const id = uid();
  eq(normalizeItem({ id, title: 'a' }).id, id);
  const fixed = normalizeItem({ id: 'bad', title: 'a' }).id;
  assert(UUID.test(fixed) && fixed !== 'bad', 'new uuid expected');
});

test('normalizeItem: 評価は3〜5に収める', () => {
  eq(normalizeItem({ title: 'a', rating: 9 }).rating, 5);
  eq(normalizeItem({ title: 'a', rating: 1 }).rating, 3);
  eq(normalizeItem({ title: 'a', rating: 'x' }).rating, 3);
  eq(normalizeItem({ title: 'a', rating: 4.2 }).rating, 4.2);
});

test('normalizeItem: タグは重複と空を除く。配列でなければ空', () => {
  eq(normalizeItem({ title: 'a', tags: [' x ', 'x', '', 'y'] }).tags, ['x', 'y']);
  eq(normalizeItem({ title: 'a', tags: null }).tags, []);
});

test('normalizeItem: 表紙は画像のdata URLだけを通す（XSS対策）', () => {
  eq(normalizeItem({ title: 'a', cover: 'x" onerror="window.__xss=1' }).cover, null);
  eq(normalizeItem({ title: 'a', cover: 'data:image/svg+xml;base64,AAAA' }).cover, null);
  eq(normalizeItem({ title: 'a', cover: 'data:image/png;base64,AAAA' }).cover, 'data:image/png;base64,AAAA');
});

test('normalizeItem: タイトルが空の記録は捨てる。削除済みは残す', () => {
  eq(normalizeItem({ title: '  ' }), null);
  assert(normalizeItem({ title: '', deleted: true }) !== null, 'tombstone must be kept');
  eq(normalizeItem(null), null);
});

test('validDay: 存在しない日付は無効', () => {
  eq(validDay('2026-02-28'), '2026-02-28');
  eq(validDay('2026-02-30'), null);
  eq(validDay('abc'), null);
  eq(validDay(null), null);
});

test('normalizeItem: 更新日が不正なら追加日にそろえる', () => {
  const item = normalizeItem({ title: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: 'garbage' });
  eq(item.updatedAt, '2026-01-01T00:00:00.000Z');
});

// ---- 統合・並べ替え・ごみ箱の自動整理 ----
test('mergeItems: 新しい方を採用し、片方にしかない記録も残す', () => {
  const a = make({ title: 'old', updatedAt: ago(5) });
  const newer = { ...a, title: 'new', updatedAt: ago(1) };
  const onlyRemote = make({ title: 'remote' });
  const merged = mergeItems([a], [newer, onlyRemote]);
  eq(merged.map(x => x.title).sort(), ['new', 'remote']);
});

test('compactTrash: 30日たったごみ箱の中身だけを消す', () => {
  const oldTrash = make({ deleted: true, updatedAt: ago(31), notes: 'メモ' });
  const freshTrash = make({ deleted: true, updatedAt: ago(29) });
  const live = make({ updatedAt: ago(100) });
  const [a, b, c] = compactTrash([oldTrash, freshTrash, live]);
  eq([a.title, a.notes, a.deleted], ['', '', true]);
  eq(b.title, '作品');
  eq(c.title, '作品');
});

test('compareItems: 読んだ日の未入力は、どちらの並びでも最後', () => {
  const a = make({ title: 'a', readAt: '2026-03-01' }), b = make({ title: 'b', readAt: '2026-05-01' }), c = make({ title: 'c', readAt: null });
  eq([a, b, c].sort((x, y) => compareItems('read', x, y)).map(x => x.title), ['b', 'a', 'c']);
  eq([a, b, c].sort((x, y) => compareItems('readold', x, y)).map(x => x.title), ['a', 'b', 'c']);
});

// ---- 絞り込み ----
test('絞り込み: ジャンルはOR、タグはAND、検索はメモも対象', () => {
  setItems([
    make({ title: 'A', genre: '本', tags: ['x', 'y'] }),
    make({ title: 'B', genre: '漫画', tags: ['x'] }),
    make({ title: 'C', genre: 'アニメ', tags: ['y', 'x'], notes: '名場面' }),
    make({ title: 'D', genre: '本', tags: [] })
  ]);
  filters.genre.add('本'); filters.genre.add('漫画');
  eq(visible().map(x => x.title).sort(), ['A', 'B', 'D']);
  filters.tag.add('x'); filters.tag.add('y');
  eq(visible().map(x => x.title), ['A']);
  filters.genre.clear(); filters.tag.clear();
  $('#query').value = '名場面';
  eq(visible().map(x => x.title), ['C']);
});

test('一覧: 24件ずつ表示し、「さらに表示」で続きが出る', () => {
  setItems(Array.from({ length: 30 }, (_, i) => make({ title: 'N' + i })));
  eq(document.querySelectorAll('#grid article').length, 24);
  assert(!$('#more').hidden, 'more button should be visible');
  $('#more').click();
  eq(document.querySelectorAll('#grid article').length, 30);
  assert($('#more').hidden, 'more button should hide');
});

test('一覧: カードに作品名入りの読み上げ名が付く', () => {
  setItems([make({ title: '火車' })]);
  eq($('#grid .open').getAttribute('aria-label'), '火車を開く');
  eq($('#grid .edit').getAttribute('aria-label'), '火車を編集');
});

// ---- 保存 ----
test('commit: 保存に失敗したら元に戻し、falseを返す', () => {
  const before = [make({ title: 'keep' })];
  state.items = before;
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  let result;
  try { result = commit([...before, make({ title: 'new' })]); }
  finally { Storage.prototype.setItem = original; }
  eq(result, false);
  eq(state.items.map(x => x.title), ['keep']);
  assert(alerts.length === 1, 'user must be told');
});

test('プレビュー: 悪意のある表紙文字列でも、属性を注入できない', () => {
  preview('x" onerror="window.__xss=1');
  const img = $('#preview img');
  assert(img && !img.hasAttribute('onerror'), 'no injected attribute');
  eq(window.__xss, undefined);
  preview(null);
});

test('e(): HTMLをエスケープする', () => {
  eq(e('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

// ---- CSV ----
test('parseCsv: 引用符、改行、BOM、CRLFを扱う', () => {
  const rows = parseCsv('﻿a,b\r\n"x,1","he said ""hi""\nnext"\r\n');
  eq(rows, [['a', 'b'], ['x,1', 'he said "hi"\nnext']]);
});

test('CSV: 先頭が数式記号のセルには印を付け、読み込みで外す', () => {
  eq(csvCell('=SUM(1)'), "'=SUM(1)");
  eq(csvCell('普通'), '普通');
  eq(csvCell('a,b'), '"a,b"');
  const [item] = csvItems("タイトル,ジャンル\r\n'=危険,本\r\n");
  eq(item.title, '=危険');
});

test('csvItems: ブクログ風の見出し、星、日付、タグを読み取る', () => {
  const csv = 'カテゴリ,評価,レビュー,タグ,読書メモ(ネタバレ),登録日時,読了日,タイトル\r\n' +
    '本,5,"最高,でした",SF、名作,メモ,2020-01-05 10:00:00,2020/2/3,新しい本\r\n' +
    '本,★★★★,,,,,,星の本\r\n' +
    '本,1,,,,,,低評価の本\r\n';
  const [a, b, c] = csvItems(csv);
  eq([a.title, a.genre, a.rating, a.readAt, a.tags, a.notes], ['新しい本', '本', 5, '2020-02-03', ['SF', '名作'], '最高,でした\n\nメモ']);
  eq(b.rating, 4);
  eq(c.rating, 3);
});

test('csvItems: タイトル列のないCSVは受け付けない', () => {
  eq(csvItems('a,b\r\n1,2\r\n'), null);
});

test('importCsv: 追加し、同じタイトルと読んだ日は読み飛ばす', () => {
  setItems([make({ title: '既存', readAt: '2026-01-01' })]);
  const csv = 'タイトル,読んだ日\r\n既存,2026-01-01\r\n新規,2026-02-02\r\n';
  importCsv(csv);
  eq(state.items.map(x => x.title).sort(), ['新規', '既存']);
  importCsv(csv);
  eq(state.items.length, 2);
  assert(alerts.some(m => m.includes('追加できる記録がありません')), 'second import should say nothing to add');
});

test('CSV書き出し→読み込みで、内容が往復する', async () => {
  setItems([make({ title: '=式', genre: '本', rating: 4.5, readAt: '2026-04-01', tags: ['a', 'b'], notes: '改行\nあり,"引用"' })]);
  let blob;
  const original = URL.createObjectURL;
  URL.createObjectURL = b => { blob = b; return 'blob:test'; };
  try { exportCsv(); } finally { URL.createObjectURL = original; }
  const [back] = csvItems(await blob.text());
  eq([back.title, back.genre, back.rating, back.readAt, back.tags, back.notes], ['=式', '本', 4.5, '2026-04-01', ['a', 'b'], '改行\nあり,"引用"']);
});

// ---- ごみ箱 ----
test('削除: ごみ箱に入り、中身は残る。戻せる', () => {
  const item = make({ title: '消す', notes: 'メモ' });
  setItems([item]);
  openEditor(item);
  $('#delete').click();
  eq(liveItems().length, 0);
  eq(trashItems().map(x => [x.title, x.notes]), [['消す', 'メモ']]);
  applyTrash(trashItems(), y => ({ ...y, deleted: false, updatedAt: new Date().toISOString() }));
  eq(liveItems().map(x => x.title), ['消す']);
});

test('ごみ箱: 完全に削除すると中身が消え、一覧にも出ない', () => {
  const item = make({ title: '消す', deleted: true, updatedAt: ago(1) });
  setItems([item]);
  applyTrash([item], y => emptyOf(y, new Date().toISOString()));
  eq(trashItems().length, 0);
  eq(state.items[0].title, '');
});

// ---- ジャンル・タグの整理 ----
test('ジャンルの名前変更: 既存の名前にまとめる', () => {
  setItems([make({ title: 'A', genre: '小説' }), make({ title: 'B', genre: '本' })]);
  window.prompt = () => '本';
  renameOption('genre', '小説');
  eq(genres(), ['本']);
});

test('タグの名前変更と削除', () => {
  setItems([make({ title: 'A', tags: ['x', 'y'] }), make({ title: 'B', tags: ['x'] })]);
  window.prompt = () => 'z';
  renameOption('tag', 'x');
  eq(alltags(), ['y', 'z']);
  deleteTag('y');
  eq(alltags(), ['z']);
  eq(liveItems().length, 2);
});

// ---- 読み込み（JSON） ----
test('JSON読み込み: 壊れた記録を整え、既存の記録はごみ箱へ移す', () => {
  const existing = make({ title: '既存' });
  setItems([existing]);
  importJson(JSON.stringify({ items: [{ title: '新しい', rating: 9, tags: null, cover: 'bad" onerror="x' }, { title: '' }] }));
  eq(liveItems().map(x => [x.title, x.rating, x.tags, x.cover]), [['新しい', 5, [], null]]);
  eq(trashItems().map(x => x.title), ['既存']);
});

// ---- 同期 ----
test('同期: 失敗した記録は同期待ちになり、復旧後の再送で消える', async () => {
  currentUser = { id: 'u1', email: 'a@example.com' };
  const item = make({ title: '送る' });
  setItems([item]);
  fakeCloud.fail = true;
  eq(await syncItems([item]), false);
  assert(pending.has(item.id), 'must be pending');
  fakeCloud.fail = false;
  eq(await flushPending(), true);
  eq(pending.size, 0);
  assert(fakeCloud.rows.has(item.id), 'must reach cloud');
});

test('同期: 20件ずつまとめて送る', async () => {
  currentUser = { id: 'u1' };
  const items = Array.from({ length: 45 }, () => make());
  setItems(items);
  await syncItems(items);
  eq(fakeCloud.calls.filter(c => c[0] === 'upsert').map(c => c[1]), [20, 20, 5]);
});

test('ログイン時の統合: ページをまたいで全件を読み、新しい方を採用する', async () => {
  currentUser = { id: 'u1' };
  const local = make({ title: 'ローカルだけ' });
  const stale = make({ title: '古い', updatedAt: ago(5) });
  setItems([local, stale]);
  const fresh = { ...stale, title: '新しい', updatedAt: ago(1) };
  fakeCloud.rows.set(stale.id, { id: stale.id, payload: fresh });
  for (let i = 0; i < 250; i++) { const r = make({ title: 'R' + i }); fakeCloud.rows.set(r.id, { id: r.id, payload: r }); }
  await loadCloudItems();
  eq(state.items.length, 252);
  eq(state.items.find(x => x.id === stale.id).title, '新しい');
  assert(fakeCloud.rows.has(local.id), 'local-only item must be uploaded');
  assert(fakeCloud.calls.filter(c => c[0] === 'select').length >= 3, 'must page through rows');
});

test('ログイン時の統合: 古い削除済みの印は端末とクラウドから片付ける', async () => {
  currentUser = { id: 'u1' };
  const gone = make({ title: '', deleted: true, updatedAt: ago(100) });
  setItems([gone]);
  fakeCloud.rows.set(gone.id, { id: gone.id, payload: gone });
  await loadCloudItems();
  eq(state.items.length, 0);
  assert(!fakeCloud.rows.has(gone.id), 'must be removed from cloud');
});

test('ログイン時の統合: 30日たったごみ箱は中身をクラウドでも消す', async () => {
  currentUser = { id: 'u1' };
  const trashed = make({ title: '古いごみ', deleted: true, updatedAt: ago(40), notes: '秘密' });
  setItems([trashed]);
  fakeCloud.rows.set(trashed.id, { id: trashed.id, payload: trashed });
  await loadCloudItems();
  eq(fakeCloud.rows.get(trashed.id).payload.notes, '');
  eq(fakeCloud.rows.get(trashed.id).payload.title, '');
});

test('ログイン: 別アカウントのローカル記録は引き継がない', async () => {
  localStorage.setItem(OWNER_KEY, 'someone-else');
  setItems([make({ title: '他人の記録' })]);
  await finishLogin({ id: 'u2', email: 'b@example.com' });
  eq(state.items.length, 0);
  eq(localStorage.getItem(OWNER_KEY), 'u2');
  assert(!fakeCloud.rows.size, 'must not upload another account data');
});

test('ログアウト: 端末の記録と所有者の印を消す', () => {
  currentUser = { id: 'u1' };
  localStorage.setItem(OWNER_KEY, 'u1');
  setItems([make()]);
  applySignedOut();
  eq(state.items.length, 0);
  eq(localStorage.getItem(OWNER_KEY), null);
  eq(currentUser, null);
});

test('ログイン中のアカウントを表示する', () => {
  currentUser = { id: 'u1', email: 'me@example.com' };
  updateSyncStatus();
  assert(!$('#account-label').hidden && $('#account-label').textContent.includes('me@example.com'), 'email shown');
  currentUser = null;
  updateSyncStatus();
  assert($('#account-label').hidden, 'hidden when signed out');
});

test('アカウント削除: 関数を呼び、端末の記録も消す', async () => {
  currentUser = { id: 'u1' };
  setItems([make()]);
  window.prompt = () => '削除';
  await deleteAccount();
  assert(fakeCloud.calls.some(c => c[0] === 'rpc' && c[1] === 'delete_my_account'), 'rpc called');
  eq(state.items.length, 0);
});

test('アカウント削除: 確認の言葉が違えば、何も起きない', async () => {
  currentUser = { id: 'u1' };
  setItems([make()]);
  window.prompt = () => 'やめる';
  await deleteAccount();
  eq(fakeCloud.calls.length, 0);
  eq(state.items.length, 1);
});

// ---- 振り返り ----
test('振り返り: 件数・平均・特によかったものを数える', () => {
  const year = String(new Date().getFullYear());
  setItems([
    make({ title: 'A', rating: 5, readAt: `${year}-03-01` }),
    make({ title: 'B', rating: 3, readAt: `${year}-03-15` }),
    make({ title: 'C', rating: 4, readAt: `${Number(year) - 1}-12-31` })
  ]);
  openReview();
  $('#review-dialog').close();
  $('#review-year').value = year;
  drawReview();
  eq([...document.querySelectorAll('#review-summary div')].map(d => d.textContent), ['2記録', '4.0平均評価', '1特によかった']);
  eq([...document.querySelectorAll('#review-top li')].map(li => li.textContent.includes('A')), [true]);
});

test('トースト: 表示される', () => {
  showToast('こんにちは');
  assert(!$('#toast').hidden && $('#toast').textContent === 'こんにちは', 'toast visible');
});

test('後片付け', () => {
  resetApp();
  window.alert = originalAlert;
  window.confirm = originalConfirm;
  window.prompt = originalPrompt;
  HTMLAnchorElement.prototype.click = originalClick;
});

// 各テストの前に初期化する
(() => {
  const names = __tests.map(t => t.fn);
  __tests.forEach((t, i) => {
    if (t.name === '後片付け') return;
    const fn = names[i];
    t.fn = async () => { resetApp(); return fn(); };
  });
})();

// ---- 上限と、時計のずれ ----
test('normalizeItem: 未来の更新日時・追加日時は今に直す。少しのずれは残す', () => {
  const before = Date.now();
  const item = normalizeItem({ title: 'a', createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' });
  assert(new Date(item.updatedAt) >= before && new Date(item.updatedAt) <= Date.now(), 'updatedAt clamped');
  assert(new Date(item.createdAt) <= Date.now(), 'createdAt clamped');
  const near = new Date(Date.now() + 60000).toISOString();
  eq(normalizeItem({ title: 'a', updatedAt: near }).updatedAt, near);
});

test('同期: 未来の日時で届いた記録も、あとの編集で上書きできる', () => {
  const id = uid();
  const [remote] = [normalizeItem({ id, title: '未来', updatedAt: '2099-01-01T00:00:00.000Z' })];
  const edited = { ...remote, title: '直した', updatedAt: new Date(Date.now() + 1000).toISOString() };
  eq(mergeItems([remote], [edited])[0].title, '直した');
});

test('scaleImage: 細かい画像でも、表紙は COVER_LIMIT 以内に収める', async () => {
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 1600;
  const g = c.getContext('2d'), data = g.createImageData(c.width, c.height);
  for (let i = 0; i < data.data.length; i++) data.data[i] = (i * 2654435761 >>> 7) & 255;
  g.putImageData(data, 0, 0);
  const raw = c.toDataURL('image/png');
  assert(raw.length > COVER_LIMIT, 'source must be large');
  const small = await scaleImage(raw);
  assert(small.length <= COVER_LIMIT && COVER.test(small), `got ${small.length}`);
});

test('同期: クラウドの上限に達したら、同期待ちに残し、一度だけ知らせる', async () => {
  resetApp();
  limitWarned = false;
  currentUser = { id: 'u1' };
  const item = make({ title: '多すぎ' });
  setItems([item]);
  fakeCloud.upsertError = { message: 'library_limit: too many items', code: 'P0001' };
  const shown = [];
  const original = window.showToast;
  showToast = message => shown.push(message);
  try {
    eq(await syncItems([item]), false);
    eq(await syncItems([item]), false);
  } finally { showToast = original; }
  assert(pending.has(item.id), 'kept pending');
  eq(shown.length, 1);
  assert(shown[0].includes('上限'), 'mentions the limit');
  fakeCloud.upsertError = null;
  currentUser = null;
});
