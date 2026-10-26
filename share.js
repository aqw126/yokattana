// 共有リンクの閲覧ページ。サーバーから受け取った内容は、すべて textContent で表示する（HTMLとしては扱わない）
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// メモ・引用の中の「||」で囲んだ部分はネタバレ。押すと、その部分だけが表示される
const SHARE_SPOILER = /\|\|([\s\S]+?)\|\|/g;

function withSpoilers(tag, text) {
  const el = node(tag, '');
  const value = String(text);
  let last = 0;
  for (const m of value.matchAll(SHARE_SPOILER)) {
    if (m.index > last) el.append(value.slice(last, m.index));
    const button = node('button', 'spoiler-reveal', 'ネタバレ（押すと表示）');
    button.type = 'button';
    button.onclick = () => button.replaceWith(node('span', 'spoiler-shown', m[1]));
    el.append(button);
    last = m.index + m[0].length;
  }
  if (last < value.length) el.append(value.slice(last));
  return el;
}

function formatDay(value) {
  const d = new Date(value);
  return isNaN(d) ? '' : new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(d);
}

function renderMessage(root, text) {
  root.textContent = '';
  root.append(node('p', 'share-message', text));
}

function renderShareItem(item) {
  const card = node('article', 'share-item');
  const head = node('div', 'share-item-head');
  head.append(node('b', '', String(item.genre ?? '')), node('strong', '', '★ ' + Number(item.rating).toFixed(1)));
  card.append(head, node('h2', '', String(item.title ?? '')));
  if (item.readAt) card.append(node('p', 'share-date', formatDay(item.readAt + 'T00:00:00') + ' に読んだ'));
  if (Array.isArray(item.tags) && item.tags.length) {
    const tags = node('div', 'tags');
    item.tags.forEach(tag => tags.append(node('span', '', String(tag))));
    card.append(tags);
  }
  if (item.notes || item.quote) {
    const body = node('div', 'share-body');
    if (item.notes) body.append(withSpoilers('p', item.notes));
    if (item.quote) body.append(withSpoilers('blockquote', item.quote));
    if (item.spoiler) {
      // 以前の共有（記録全体がネタバレの印）は、閉じた状態で表示する
      const details = node('details', 'share-spoiler');
      details.append(node('summary', '', 'ネタバレを含みます（開くと表示）'), body);
      card.append(details);
    }
    else card.append(body);
  }
  return card;
}

function renderShare(root, result) {
  const payload = (result && result.payload) || {};
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 200) : [];
  root.textContent = '';
  root.append(node('h1', '', String(payload.title || '共有された記録')));
  const meta = [payload.criteria, `${items.length}件`, payload.sharedAt ? formatDay(payload.sharedAt) + ' に共有' : ''].filter(Boolean).join(' ・ ');
  root.append(node('p', 'share-meta', meta));
  const spoilers = items.some(x => x.spoiler || [x.notes, x.quote].some(t => new RegExp(SHARE_SPOILER.source).test(String(t || ''))));
  if (spoilers) root.append(node('p', 'share-note', 'ネタバレの部分は隠しています。押すと表示されます。'));
  const list = node('div', 'share-list');
  items.forEach(item => list.append(renderShareItem(item)));
  root.append(list);
}

async function loadShare() {
  const root = document.getElementById('share-root');
  const token = location.hash.slice(1);
  if (!SHARE_TOKEN_PATTERN.test(token)) return renderMessage(root, 'リンクが正しくありません。');
  const cloud = window.supabase?.createClient(window.SUPABASE_CONFIG?.url, window.SUPABASE_CONFIG?.publishableKey);
  if (!cloud) return renderMessage(root, '読み込めませんでした。');
  try {
    const { data, error } = await cloud.rpc('get_share', { p_id: token });
    if (error) throw error;
    if (!data) return renderMessage(root, 'このリンクは、見つからないか、期限が切れています。');
    renderShare(root, data);
  }
  catch {
    renderMessage(root, '読み込めませんでした。通信状況を確認して、もう一度お試しください。');
  }
}

if (document.body.dataset.page === 'share') {
  loadShare();
  window.addEventListener('hashchange', () => location.reload());
}
