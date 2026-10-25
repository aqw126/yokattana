"""index.html のキャッシュ回避用バージョン (?v=...) を更新する。

styles.css / app.js / supabase-config.js を変更したら、公開前に実行する:
    python tools/bump-version.py
"""
import re
import time
from pathlib import Path

path = Path(__file__).resolve().parent.parent / "index.html"
html = path.read_text(encoding="utf-8")
version = time.strftime("%Y%m%d%H%M")
html, count = re.subn(r"((?:styles\.css|app\.js|supabase-config\.js)\?v=)[\w.]+", rf"\g<1>{version}", html)
path.write_text(html, encoding="utf-8")
print(f"{count} 箇所を v={version} に更新しました")
