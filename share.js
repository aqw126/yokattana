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

// 共有に含めた表紙は、小さな WebP か JPEG の data URL だけを受け付ける
const SHARE_COVER_PATTERN = /^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

// ★の数を、5つの星の塗りで見せる（3.0〜5.0）
function renderStars(rating) {
  const value = Math.min(5, Math.max(0, Number(rating) || 0));
  const stars = node('span', 'share-stars');
  stars.setAttribute('aria-label', `評価 ${value.toFixed(1)}`);
  const fill = node('span', 'share-stars-fill', '★★★★★');
  fill.style.width = `${value / 5 * 100}%`;
  stars.append(node('span', 'share-stars-base', '★★★★★'), fill);
  const wrap = node('span', 'share-rating');
  wrap.append(stars, node('strong', '', value.toFixed(1)));
  return wrap;
}

function renderCover(item) {
  const art = node('div', 'share-art');
  if (typeof item.cover === 'string' && SHARE_COVER_PATTERN.test(item.cover)) {
    const img = node('img', '');
    img.alt = '';
    img.loading = 'lazy';
    img.src = item.cover;
    art.append(img);
  }
  else art.append(node('span', '', String(item.title ?? '').trim().slice(0, 1)));
  return art;
}

function renderShareItem(item) {
  const card = node('article', 'share-item');
  if (Number(item.rating) >= 4.5) card.classList.add('top');
  const main = node('div', 'share-main');
  const head = node('div', 'share-item-head');
  head.append(node('b', '', String(item.genre ?? '')), renderStars(item.rating));
  main.append(head, node('h2', '', String(item.title ?? '')));
  if (item.readAt) main.append(node('p', 'share-date', formatDay(item.readAt + 'T00:00:00')));
  if (Array.isArray(item.tags) && item.tags.length) {
    const tags = node('div', 'tags');
    item.tags.forEach(tag => tags.append(node('span', '', String(tag))));
    main.append(tags);
  }
  card.append(renderCover(item), main);
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
  const header = node('div', 'share-header');
  header.append(node('p', 'share-eyebrow', 'SHARED SHELF'), node('h1', '', String(payload.title || '共有された記録')));
  const ratings = items.map(x => Number(x.rating)).filter(x => x > 0);
  const stats = node('div', 'share-stats');
  [[`${items.length}`, '件'], ratings.length ? [(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1), '平均★'] : null, [`${items.filter(x => Number(x.rating) >= 4.5).length}`, '特によかった']]
    .filter(Boolean).forEach(([value, label]) => {
      const stat = node('div', '');
      stat.append(node('strong', '', value), node('small', '', label));
      stats.append(stat);
    });
  header.append(stats);
  const meta = [payload.criteria, payload.sharedAt ? formatDay(payload.sharedAt) + ' に共有' : ''].filter(Boolean).join(' ・ ');
  if (meta) header.append(node('p', 'share-meta', meta));
  root.append(header);
  const spoilers = items.some(x => x.spoiler || [x.notes, x.quote].some(t => new RegExp(SHARE_SPOILER.source).test(String(t || ''))));
  if (spoilers) root.append(node('p', 'share-note', 'ネタバレの部分は隠しています。押すと表示されます。'));
  const list = node('div', 'share-list');
  items.forEach(item => list.append(renderShareItem(item)));
  root.append(list);
  const invite = node('p', 'share-invite');
  const link = node('a', '', 'よかっ棚で、自分の棚をつくる');
  link.href = './';
  invite.append(link);
  root.append(invite);
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
