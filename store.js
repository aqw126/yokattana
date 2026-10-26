// この端末の保存先（IndexedDB）。localStorage（約5MB）では、表紙つきの記録が増えると入りきらないため。
// 記録（items）と表紙（covers）を分けて持つ。表紙は画像のまま（Blob）、中身のハッシュ（SHA-256）を名前にして保存する。
// 同じ画像は1つで済み、一度保存した表紙は書き換えない。設定や移行の記録は meta に置く。
// 使えないブラウザでは open() が失敗し、app.js は以前の localStorage の保存に戻る。
const LocalStore = (() => {
  const NAME = window.YOKATTANA_DB || 'yokattana', VERSION = 1;
  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('IndexedDB を使えません')); return; }
        const request = indexedDB.open(NAME, VERSION);
        // 版を上げるときは、ここに「前の版からの差分」だけを足していく（既存のデータは消さない）
        request.onupgradeneeded = event => {
          const db = request.result;
          if (event.oldVersion < 1) {
            db.createObjectStore('items', { keyPath: 'id' });
            db.createObjectStore('covers', { keyPath: 'hash' });
            db.createObjectStore('meta');
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          // 別のタブが新しい版で開いたら、こちらは閉じて、次の操作で開き直す
          db.onversionchange = () => { db.close(); opening = null; };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('ほかのタブが古い版で開いています'));
      });
      opening.catch(() => { opening = null; });
    }
    return opening;
  }

  const wait = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  // 1つのトランザクションで読み書きし、書き込みが確定してから結果を返す
  async function run(stores, mode, work) {
    const db = await open();
    const tx = db.transaction(stores, mode);
    const finished = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('保存を中断しました'));
    });
    const result = work(tx);
    await finished;
    return result;
  }

  async function hashOf(blob) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  return {
    open,
    async loadItems() {
      return run(['items'], 'readonly', tx => wait(tx.objectStore('items').getAll()));
    },
    async writeItems(put, deleteIds = []) {
      await run(['items'], 'readwrite', tx => {
        const store = tx.objectStore('items');
        put.forEach(item => store.put(item));
        deleteIds.forEach(id => store.delete(id));
      });
    },
    async replaceItems(items) {
      await run(['items'], 'readwrite', tx => {
        const store = tx.objectStore('items');
        store.clear();
        items.forEach(item => store.put(item));
      });
    },
    // 表紙を保存し、ハッシュを返す。名前が中身のハッシュなので、同じ画像を書き直しても中身は変わらない
    async putCover(blob) {
      const hash = await hashOf(blob);
      await run(['covers'], 'readwrite', tx => { tx.objectStore('covers').put({ hash, blob, type: blob.type, size: blob.size }); });
      return hash;
    },
    async getCover(hash) {
      const row = await run(['covers'], 'readonly', tx => wait(tx.objectStore('covers').get(hash)));
      return row ? row.blob : null;
    },
    async coverHashes() {
      return run(['covers'], 'readonly', tx => wait(tx.objectStore('covers').getAllKeys()));
    },
    async deleteCovers(hashes) {
      if (!hashes.length) return;
      await run(['covers'], 'readwrite', tx => { const store = tx.objectStore('covers'); hashes.forEach(h => store.delete(h)); });
    },
    async getMeta(key) {
      return run(['meta'], 'readonly', tx => wait(tx.objectStore('meta').get(key)));
    },
    async setMeta(key, value) {
      await run(['meta'], 'readwrite', tx => { tx.objectStore('meta').put(value, key); });
    },
    async deleteMeta(key) {
      await run(['meta'], 'readwrite', tx => { tx.objectStore('meta').delete(key); });
    },
    // ログアウト・アカウント削除・別アカウントでのログインのとき。移行の記録（meta）は残す
    async clearRecords() {
      await run(['items', 'covers'], 'readwrite', tx => { tx.objectStore('items').clear(); tx.objectStore('covers').clear(); });
    },
    hashOf
  };
})();
