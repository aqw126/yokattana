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
