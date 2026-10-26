// この端末の保存先（IndexedDB）と、localStorage からの移行のテスト
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function freshStore() {
  resetApp();
  await whenSaved();
  await LocalStore.clearRecords();
  await LocalStore.deleteMeta('legacyBackup');
  await LocalStore.deleteMeta('legacyMigratedAt');
  localStorage.removeItem(KEY);
}

test('保存先: このブラウザでは IndexedDB を使っている', () => {
  eq(storeMode, 'idb');
});

test('移行: localStorage の記録と表紙を IndexedDB に移し、確かめてから localStorage を空ける', async () => {
  await freshStore();
  const withCover = make({ title: '表紙あり', cover: PNG }), plain = make({ title: '表紙なし' });
  const raw = JSON.stringify([withCover, plain]);
  localStorage.setItem(KEY, raw);
  await migrateLegacy();
  const saved = new Map((await LocalStore.loadItems()).map(x => [x.title, x]));
  eq([...saved.keys()].sort(), ['表紙あり', '表紙なし']);
  const ref = saved.get('表紙あり').cover;
  assert(COVER_REF.test(ref.hash), 'cover moved as a reference');
  const blob = await LocalStore.getCover(ref.hash);
  eq(await blobToDataUrl(blob), PNG);
  eq(saved.get('表紙あり').updatedAt, withCover.updatedAt);
  eq(localStorage.getItem(KEY), null);
  eq(await LocalStore.getMeta('legacyBackup'), raw);
  assert(await LocalStore.getMeta('legacyMigratedAt'), 'marked as done');
});

test('移行: 2回目は何もせず、30日たつと移行前の控えを消す', async () => {
  await freshStore();
  localStorage.setItem(KEY, JSON.stringify([make({ title: 'A' })]));
  await migrateLegacy();
  await migrateLegacy();
  eq((await LocalStore.loadItems()).length, 1);
  assert(await LocalStore.getMeta('legacyBackup'), 'backup kept for now');
  await LocalStore.setMeta('legacyMigratedAt', Date.now() - 31 * DAY);
  await migrateLegacy();
  eq(await LocalStore.getMeta('legacyBackup'), undefined);
});

test('移行: 書き込みに失敗したら、localStorage はそのまま残す', async () => {
  await freshStore();
  const raw = JSON.stringify([make({ title: '残す' })]);
  localStorage.setItem(KEY, raw);
  const original = LocalStore.writeItems;
  LocalStore.writeItems = () => Promise.reject(new Error('disk'));
  let failed = false;
  try { await migrateLegacy(); } catch { failed = true; } finally { LocalStore.writeItems = original; }
  assert(failed, 'migration reports the failure');
  eq(localStorage.getItem(KEY), raw);
  eq(await LocalStore.getMeta('legacyMigratedAt'), undefined);
  localStorage.removeItem(KEY);
});

test('正規化: 表紙の参照を受け付け、不正なハッシュは捨てる。知らない項目は残す', () => {
  const hash = 'a'.repeat(64);
  eq(normalizeItem({ title: 'a', cover: { hash } }).cover, { hash });
  eq(normalizeItem({ title: 'a', cover: { hash: 'xyz' } }).cover, null);
  eq(normalizeItem({ title: 'a', cover: { hash: 'A'.repeat(64) } }).cover, null);
  const item = normalizeItem({ title: 'a', mood: '泣ける', series: { name: 'x', no: 2 }, 'bad key': 1, __proto__x: 1 });
  eq([item.mood, item.series], ['泣ける', { name: 'x', no: 2 }]);
  eq('bad key' in item, false);
  eq(normalizeItem({ title: 'a', mood: 'x' }).title, 'a');
});

test('表紙: 保存すると参照になり、カードには画像として出る。書き出しと同期では data URL に戻す', async () => {
  await freshStore();
  const cover = await storeCover(PNG);
  assert(COVER_REF.test(cover.hash), 'reference');
  eq((await LocalStore.getCover(cover.hash)).type, 'image/png');
  setItems([make({ title: '画像', cover })]);
  const img = document.querySelector('#grid article img');
  for (let i = 0; i < 50 && !img.src; i++) await new Promise(r => setTimeout(r, 20));
  assert(img.src.startsWith('blob:') && !img.hidden, 'shown from IndexedDB');
  eq((await withInlineCover(state.items[0])).cover, PNG);
  currentUser = { id: 'u1' };
  await syncItems(state.items);
  eq(fakeCloud.rows.get(state.items[0].id).payload.cover, PNG);
  currentUser = null;
});

test('表紙: 見つからない参照は、頭文字の表示に戻る', async () => {
  await freshStore();
  setItems([make({ title: '迷子', cover: { hash: 'b'.repeat(64) } })]);
  const card = document.querySelector('#grid article');
  for (let i = 0; i < 50 && !card.querySelector('img').hidden; i++) await new Promise(r => setTimeout(r, 20));
  assert(card.querySelector('img').hidden && !card.querySelector('.art span').hidden, 'letter shown');
  eq(card.querySelector('.art span').textContent, '迷');
});

test('表紙: data URL の表紙は、更新日時を変えずに IndexedDB へ移し、同期待ちにもしない', async () => {
  await freshStore();
  const item = make({ title: '移す', cover: PNG });
  setItems([item]);
  await internSoon();
  const moved = state.items[0];
  assert(COVER_REF.test(moved.cover.hash), 'moved');
  eq(moved.updatedAt, item.updatedAt);
  eq(pending.size, 0);
});

test('表紙: どの記録からも使われない表紙は消し、ごみ箱の記録の表紙は残す', async () => {
  await freshStore();
  const used = await storeCover(PNG), trashed = await storeCover(PNG.replace('ggg==', 'gggA='));
  const unused = await LocalStore.putCover(new Blob(['x'], { type: 'image/png' }));
  setItems([make({ cover: used }), make({ deleted: true, cover: trashed })]);
  await whenSaved();
  await collectCovers();
  eq((await LocalStore.coverHashes()).sort(), [used.hash, trashed.hash].sort());
  assert(!(await LocalStore.coverHashes()).includes(unused), 'unused removed');
});

test('ログアウト: IndexedDB の記録・表紙・移行前の控えを消す', async () => {
  await freshStore();
  await LocalStore.setMeta('legacyBackup', '[]');
  currentUser = { id: 'u1' };
  setItems([make({ cover: await storeCover(PNG) })]);
  await whenSaved();
  applySignedOut();
  await whenSaved();
  eq([(await LocalStore.loadItems()).length, (await LocalStore.coverHashes()).length], [0, 0]);
  eq(await LocalStore.getMeta('legacyBackup'), undefined);
});

test('書き出し: 表紙は data URL に戻して、以前と同じ形の JSON にする', async () => {
  await freshStore();
  setItems([make({ title: '表紙', cover: await storeCover(PNG) })]);
  let blob;
  const original = URL.createObjectURL;
  URL.createObjectURL = b => { blob = b; return 'blob:test'; };
  try { await backup(); } finally { URL.createObjectURL = original; }
  const json = JSON.parse(await blob.text());
  eq(json.items[0].cover, PNG);
  // 書き出した JSON は、そのまま読み込める
  await importJson(JSON.stringify(json));
  await internSoon();
  assert(COVER_REF.test(state.items.find(x => x.title === '表紙' && !x.deleted).cover.hash), 'imported cover is stored again');
});

test('データの管理: この端末の使用量を表示する', async () => {
  await freshStore();
  setItems([make(), make({ cover: await storeCover(PNG) })]);
  await showStorageUsage();
  assert(/^この端末の保存：記録2件・表紙1枚/.test($('#storage-usage').textContent), $('#storage-usage').textContent);
});

test('ごみ箱: 中身を消すときは、知らない項目も残さない', () => {
  const emptied = emptyOf(normalizeItem({ title: 'a', notes: 'n', mood: '秘密の気持ち' }), new Date().toISOString());
  eq('mood' in emptied, false);
  eq([emptied.title, emptied.deleted], ['', true]);
});
