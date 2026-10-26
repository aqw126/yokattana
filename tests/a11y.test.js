// アクセシビリティの自動チェック。画面の骨組みと、色の組み合わせを確認する
const indexDoc = window.__indexDoc;

function accessibleName(el) {
  const labelledby = el.getAttribute('aria-labelledby');
  const fromIds = labelledby && labelledby.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
  const labels = el.labels ? [...el.labels].map(l => l.textContent).join(' ') : '';
  return (el.getAttribute('aria-label') || fromIds || labels || el.textContent || el.getAttribute('title') || '').trim();
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

test('a11y: ページの言語・タイトル・拡大の制限がない', () => {
  eq(indexDoc.documentElement.lang, 'ja');
  assert(indexDoc.title.trim().length > 0, 'title');
  const viewport = indexDoc.querySelector('meta[name=viewport]').content;
  assert(!/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(viewport), 'zoom must stay possible');
});

test('a11y: 本文へ移動するリンクがあり、移動先が存在する', () => {
  const skip = indexDoc.querySelector('a.skip-link');
  assert(skip, 'skip link');
  assert(indexDoc.querySelector(skip.getAttribute('href')), 'skip target');
  assert(indexDoc.querySelector('main'), 'main landmark');
});

test('a11y: すべての操作部品に名前がある', () => {
  const unnamed = [...document.querySelectorAll('#app-root button, #app-root input:not([type=hidden]), #app-root select, #app-root textarea, #app-root summary, #app-root a[href]')]
    .filter(el => !accessibleName(el)).map(el => el.outerHTML.slice(0, 80));
  eq(unnamed, []);
});

test('a11y: idが重複していない', () => {
  const ids = [...document.querySelectorAll('#app-root [id]')].map(el => el.id);
  eq(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('a11y: ダイアログに名前が付いている', () => {
  const dialogs = [...document.querySelectorAll('#app-root dialog')];
  assert(dialogs.length >= 6, 'dialogs exist');
  const unnamed = dialogs.filter(d => !accessibleName(d)).map(d => d.id);
  eq(unnamed, []);
});

test('a11y: 閉じるボタンに読み上げ名がある', () => {
  const closers = [...document.querySelectorAll('#app-root .x')];
  assert(closers.length >= 5, 'close buttons exist');
  eq(closers.filter(b => !b.getAttribute('aria-label')).length, 0);
});

test('a11y: 状態の通知は読み上げられる領域にある', () => {
  eq($('#toast').getAttribute('role'), 'status');
  eq($('#toast').getAttribute('aria-live'), 'polite');
  eq($('#auth-message').getAttribute('aria-live'), 'polite');
});

test('a11y: 見出しの階層が飛んでいない', () => {
  const levels = [...indexDoc.querySelectorAll('h1,h2,h3')].map(h => Number(h.tagName[1]));
  eq(levels.filter(l => l === 1).length, 1);
  levels.forEach((level, i) => assert(i === 0 || level - levels[i - 1] <= 1, `heading jump at ${i}`));
});

test('a11y: 文字色と背景の対比が基準（4.5:1）を満たす（ライト・ダーク）', () => {
  const root = document.documentElement, saved = root.getAttribute('data-theme');
  const bad = [];
  try {
    ['light', 'dark'].forEach(theme => {
      root.setAttribute('data-theme', theme);
      const backgrounds = ['--canvas', '--paper', '--pale', '--surface', '--field'].map(cssVar);
      ['--ink', '--muted', '--warm', '--dark', '--danger'].forEach(name => {
        backgrounds.forEach(bg => { const ratio = contrast(cssVar(name), bg); if (ratio < 4.5) bad.push(`${theme} ${name} on ${bg} = ${ratio.toFixed(2)}`); });
      });
      [['--on-sage', '--sage'], ['--on-dark', '--dark'], ['--sage', '--surface'], ['--sage', '--canvas']].forEach(([fg, bg]) => {
        const ratio = contrast(cssVar(fg), cssVar(bg));
        if (ratio < 4.5) bad.push(`${theme} ${fg} on ${bg} = ${ratio.toFixed(2)}`);
      });
    });
  }
  finally {
    if (saved === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', saved);
  }
  eq(bad, []);
});

test('a11y: フォーカスの枠線が定義されている', () => {
  let found = false;
  for (const sheet of document.styleSheets) {
    try { for (const rule of sheet.cssRules) if (rule.selectorText && rule.selectorText.includes(':focus-visible')) found = true; }
    catch {}
  }
  assert(found, ':focus-visible rule');
});

test('a11y: 動きを減らす設定に対応している', () => {
  let found = false;
  for (const sheet of document.styleSheets) {
    try { for (const rule of sheet.cssRules) if (rule.media && rule.media.mediaText.includes('prefers-reduced-motion')) found = true; }
    catch {}
  }
  assert(found, 'prefers-reduced-motion');
});

test('a11y: 表紙画像に代替テキストがある', () => {
  resetApp();
  setItems([make({ title: '火車', cover: 'data:image/png;base64,iVBORw0KGgo=' })]);
  const img = document.querySelector('#grid img');
  eq(img.alt, '火車の表紙');
});

test('a11y: 選択状態をボタンの属性でも伝える', () => {
  resetApp();
  setItems([make({ genre: '本' })]);
  $('#entryGenre').value = '本';
  renderGenreChips();
  eq($('#genre-chips button').getAttribute('aria-pressed'), 'true');
});

test('テーマ: 自動→ライト→ダークと切り替わり、保存される', () => {
  const root = document.documentElement, saved = root.getAttribute('data-theme');
  try {
    applyTheme('auto');
    $('#theme-toggle').click();
    eq(root.getAttribute('data-theme'), 'light');
    $('#theme-toggle').click();
    eq(root.getAttribute('data-theme'), 'dark');
    eq(localStorage.getItem('yokattana-theme'), 'dark');
    $('#theme-toggle').click();
    eq(root.getAttribute('data-theme'), null);
    assert($('#theme-toggle').getAttribute('aria-label').includes('自動'), 'label follows theme');
  }
  finally {
    if (saved === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', saved);
    applyTheme(currentTheme());
  }
});

test('a11y: 選択肢の一覧は、ライト・ダークのどちらでも文字と背景の色が分かれている', () => {
  const root = document.documentElement, before = root.getAttribute('data-theme');
  try {
    for (const theme of ['light', 'dark']) {
      root.setAttribute('data-theme', theme);
      document.querySelectorAll('select').forEach(select => {
        [select, ...select.options].forEach(el => {
          const c = getComputedStyle(el);
          assert(c.backgroundColor !== 'rgba(0, 0, 0, 0)' || el === select, `${theme}: ${select.id} option has a background`);
          assert(c.color !== c.backgroundColor, `${theme}: ${select.id} text differs from background`);
        });
      });
    }
  } finally {
    if (before === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', before);
  }
});
