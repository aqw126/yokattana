// 表示テーマを、描画の前に反映する（ちらつき防止）。切り替えは app.js が行う
try {
  const theme = localStorage.getItem('yokattana-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
}
catch {}

// 他のサイトの中（iframe）では表示しない。透明に重ねて操作を誘導する攻撃（クリックジャッキング）を防ぐ。
// GitHub Pages ではヘッダーを付けられず、<meta> の CSP では frame-ancestors が効かないため、ここで行う
if (window.top !== window.self) {
  document.documentElement.style.display = 'none';
  document.addEventListener('DOMContentLoaded', () => {
    const link = document.createElement('a');
    link.href = location.href;
    link.target = '_top';
    link.rel = 'noopener';
    link.textContent = 'よかっ棚を新しい画面で開く';
    document.body.replaceChildren(link);
    document.documentElement.style.display = '';
  });
}
