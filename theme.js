// 表示テーマを、描画の前に反映する（ちらつき防止）。切り替えは app.js が行う
try {
  const theme = localStorage.getItem('yokattana-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
}
catch {}
