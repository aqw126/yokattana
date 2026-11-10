"""セキュリティ用の静的チェック (Semgrep と言語別 Linter) をまとめて実行する。

    python tools/security-check.py              # 入っているものを全部
    python tools/security-check.py semgrep ruff # 指定したものだけ

必要なもの: semgrep / ruff / zizmor は pip、eslint は tools/lint で `npm ci`。
CI (.github/workflows/security.yml) も同じコマンドを使う。1つでも失敗すると非0で終わる。
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINT = ROOT / "tools" / "lint"

CHECKS = {
    # 独自ルール + レジストリの JS / セキュリティ系ルール (後者はネットワークが必要)
    "semgrep": ["semgrep", "scan", "--error", "--metrics=off", "--disable-version-check",
                "--config", ".semgrep/yokattana.yml", "--config", "p/javascript",
                "--config", "p/security-audit", "--config", "p/owasp-top-ten"],
    "ruff": ["ruff", "check", "."],
    # GitHub Actions の設定の脆弱性 (権限・未固定の Action・式の注入など)
    "zizmor": ["zizmor", "--no-progress", ".github/workflows"],
    "eslint": [str(LINT / "node_modules" / ".bin" / "eslint"), "-c", str(LINT / "eslint.config.mjs"),
               "*.js", "tests/*.js"],
}


def main():
    names = sys.argv[1:] or list(CHECKS)
    failed = []
    for name in names:
        if name not in CHECKS:
            sys.exit(f"不明なチェック: {name} (使えるもの: {', '.join(CHECKS)})")
        cmd = CHECKS[name]
        if not (Path(cmd[0]).exists() or shutil.which(cmd[0])):
            print(f"-- {name}: {cmd[0]} が見つからないためスキップ")
            continue
        print(f"== {name}")
        if subprocess.run(cmd, cwd=ROOT).returncode != 0:  # noqa: S603
            failed.append(name)
    if failed:
        sys.exit(f"失敗: {', '.join(failed)}")
    print("すべて通りました")


if __name__ == "__main__":
    main()
