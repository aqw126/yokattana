// Supabase クライアントの代わりに使う、メモリ上の偽物
window.fakeCloud = (() => {
  const cloud = {
    rows: new Map(),
    fail: false,
    rpcError: null,
    calls: [],
    reset() {
      cloud.rows.clear();
      cloud.fail = false;
      cloud.rpcError = null;
      cloud.insertError = null;
      cloud.upsertError = null;
      cloud.shares.clear();
      cloud.calls = [];
      cloud.files.clear();
      cloud.bucketMissing = false;
      cloud.coverQuota = false;
    },
    // Storage（表紙の置き場所）の偽物。path -> { blob, created_at }
    files: new Map(),
    bucketMissing: false,
    coverQuota: false,
    storage: {
      from() {
        const missing = () => ({ data: null, error: { message: 'Bucket not found', statusCode: '404', status: 400 } });
        return {
          upload: async (path, blob) => {
            cloud.calls.push(['upload', path]);
            if (cloud.bucketMissing) return missing();
            if (cloud.coverQuota) return { data: null, error: { message: 'new row violates row-level security policy', statusCode: '403', status: 400 } };
            if (cloud.files.has(path)) return { data: null, error: { message: 'The resource already exists', statusCode: '409', status: 400 } };
            cloud.files.set(path, { blob, created_at: new Date().toISOString() });
            return { data: { path }, error: null };
          },
          download: async path => {
            cloud.calls.push(['download', path]);
            if (cloud.bucketMissing) return missing();
            const file = cloud.files.get(path);
            return file ? { data: file.blob, error: null } : { data: null, error: { message: 'Object not found', statusCode: '404', status: 400 } };
          },
          list: async (prefix, { limit = 100, offset = 0 } = {}) => {
            if (cloud.bucketMissing) return missing();
            const names = [...cloud.files.keys()].filter(k => k.startsWith(prefix + '/')).map(k => k.slice(prefix.length + 1)).sort();
            return { data: names.slice(offset, offset + limit).map(name => ({ name, created_at: cloud.files.get(prefix + '/' + name).created_at })), error: null };
          },
          remove: async paths => {
            cloud.calls.push(['remove', paths.length]);
            paths.forEach(path => cloud.files.delete(path));
            return { data: [], error: null };
          }
        };
      }
    },
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }),
      signInWithOAuth: async () => ({ error: null })
    },
    shares: new Map(),
    from(table) {
      if (table === 'shares') {
        return {
          insert: async row => {
            cloud.calls.push(['insert-share', row.id]);
            if (cloud.insertError) return { error: cloud.insertError };
            cloud.shares.set(row.id, row);
            return { error: null };
          },
          select: () => ({
            order: async () => ({ data: [...cloud.shares.values()].map(({ id, title, item_count, created_at, expires_at }) => ({ id, title, item_count, created_at: created_at || new Date().toISOString(), expires_at })), error: null })
          }),
          delete: () => ({
            eq: async (column, id) => { cloud.shares.delete(id); return { error: null }; }
          })
        };
      }
      return {
        upsert: async rows => {
          cloud.calls.push(['upsert', rows.length]);
          if (cloud.fail) return { error: { message: 'network' } };
          if (cloud.upsertError) return { error: cloud.upsertError };
          rows.forEach(row => cloud.rows.set(row.id, row));
          return { error: null };
        },
        select: () => ({
          order: () => ({
            range: async (from, to) => {
              cloud.calls.push(['select', from, to]);
              if (cloud.fail) return { error: { message: 'network' } };
              const all = [...cloud.rows.values()].sort((a, b) => a.id.localeCompare(b.id));
              return { data: all.slice(from, to + 1).map(row => ({ payload: row.payload })), error: null };
            }
          })
        }),
        delete: () => ({
          in: async (column, ids) => {
            cloud.calls.push(['delete', ids.length]);
            ids.forEach(id => cloud.rows.delete(id));
            return { error: null };
          }
        })
      };
    },
    rpc: async name => {
      cloud.calls.push(['rpc', name]);
      return cloud.rpcError ? { error: cloud.rpcError } : { error: null };
    }
  };
  return cloud;
})();
