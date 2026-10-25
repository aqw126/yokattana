"""キャッシュ回避用のバージョン (?v=...) と、Service Worker のバージョンを更新する。

styles.css / app.js / share.js などを変更したら、公開前に実行する:
    python tools/bump-version.py
"""
import re
import time
from pathlib import Path

root = Path(__file__).resolve().parent.parent
version = time.strftime("%Y%m%d%H%M")
total = 0

for name in ("index.html", "share.html", "privacy.html"):
    path = root / name
    html = path.read_text(encoding="utf-8")
    html, count = re.subn(r"((?:styles\.css|app\.js|share\.js|supabase-config\.js)\?v=)[\w.]+", rf"\g<1>{version}", html)
    path.write_text(html, encoding="utf-8")
    total += count

sw = root / "sw.js"
text = sw.read_text(encoding="utf-8")
text, count = re.subn(r"const VERSION = '[^']*';", f"const VERSION = '{version}';", text)
sw.write_text(text, encoding="utf-8")
total += count

print(f"{total} 箇所を v={version} に更新しました")
