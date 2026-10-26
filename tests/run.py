"""ブラウザ上のテスト (tests/index.html) を、ヘッドレス Chrome で実行して結果を表示する。

    python tests/run.py

Chrome (または Chromium / Edge) が必要。環境変数 CHROME で実行ファイルを指定できる。

テストのページは、終わると結果を /__results に送る。ここではそれを（実際の時間で）待つ。
IndexedDB などの本物の読み書きを待てるように、Chrome の仮想時間（--virtual-time-budget）は使わない。
"""
import functools
import http.server
import json
import os
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

    def do_POST(self):
        if self.path != "/__results":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(204)
        self.end_headers()
        self.server.results = json.loads(body.decode("utf-8"))
        self.server.done.set()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.done = threading.Event()
    server.results = None
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile = tempfile.mkdtemp(prefix="yokattana-test-")
    browser = subprocess.Popen(
        [
            find_browser(),
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--no-first-run",
            f"--user-data-dir={profile}",
            f"http://127.0.0.1:{port}/tests/index.html",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        finished = server.done.wait(timeout=180)
    finally:
        browser.terminate()
        try:
            _, stderr = browser.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            browser.kill()
            _, stderr = browser.communicate()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    results = server.results
    if not finished or not results:
        print("テストの結果を取得できませんでした（3分以内に終わりませんでした）。")
        print((stderr or "")[-2000:])
        sys.exit(2)
    print(results["text"])
    sys.exit(1 if int(results["failed"]) else 0)


if __name__ == "__main__":
    main()
