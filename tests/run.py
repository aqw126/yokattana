"""ブラウザ上のテスト (tests/index.html) を、ヘッドレス Chrome で実行して結果を表示する。

    python tests/run.py

Chrome (または Chromium / Edge) が必要。環境変数 CHROME で実行ファイルを指定できる。
"""
import functools
import html
import http.server
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def find_browser():
    candidates = [
        os.environ.get("CHROME"),
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
        shutil.which("chrome"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    for path in candidates:
        if path and Path(path).exists():
            return path
    sys.exit("Chrome が見つかりません。環境変数 CHROME に実行ファイルのパスを指定してください。")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile = tempfile.mkdtemp(prefix="yokattana-test-")
    try:
        result = subprocess.run(
            [
                find_browser(),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--no-first-run",
                f"--user-data-dir={profile}",
                "--virtual-time-budget=60000",
                "--dump-dom",
                f"http://127.0.0.1:{port}/tests/index.html",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=180,
        )
    finally:
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    dom = result.stdout
    results = re.search(r'<pre id="results">(.*?)</pre>', dom, re.S)
    summary = re.search(r'data-summary="([^"]*)"', dom)
    failed = re.search(r'data-failed="(\d+)"', dom)
    if not results or not summary or not failed:
        print("テストの結果を取得できませんでした。")
        print(result.stderr[-2000:])
        sys.exit(2)
    print(html.unescape(results.group(1)))
    sys.exit(1 if int(failed.group(1)) else 0)


if __name__ == "__main__":
    main()
