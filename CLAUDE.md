# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 会話の言語

ユーザーとの会話は、すべて日本語で行うこと（説明・質問・作業の報告・まとめを含む）。コード中の識別子やコマンド、エラーメッセージの引用は原文のままでよい。

## Project

よかっ棚 (MediaLog): a personal web app for rating and noting books, manga, anime, films, dramas and games. Plain HTML/CSS/JS with no framework, no build step and no package manager, served as static files from GitHub Pages (https://aqw126.github.io/yokattana/). Supabase handles login (Google OAuth), the database and Storage. There is no server code of our own.

UI text, comments, docs and test names are all in Japanese. Keep that style when you edit.

## Commands

- Run all tests: `python tests/run.py`. It starts a local HTTP server, opens `tests/index.html` in headless Chrome and exits non-zero on failure. If Chrome isn't on PATH, set `CHROME=/path/to/chrome`. CI (`.github/workflows/test.yml`) runs the same command on every push to main and on every PR.
- Run tests interactively: serve the repo root (for example `python -m http.server`) and open `/tests/index.html`.
- There is no flag for running a single test. To narrow a run while debugging, temporarily drop `loadScript(...)` lines in `tests/index.html` or filter `__tests` in `tests/harness.js`.
- Security static checks: `python tools/security-check.py [semgrep|ruff|zizmor|eslint]`. Needs `pip install semgrep ruff zizmor` and `npm ci` in `tools/lint` (the only package.json; the app itself stays no-build). Custom Semgrep rules in `.semgrep/yokattana.yml` enforce the Trusted Types / no-eval constraints. CI: `.github/workflows/security.yml`. Workflow actions are pinned to commit SHAs. Dependabot (`.github/dependabot.yml`) opens a weekly PR to update them.
- After changing any versioned asset (`styles.css`, `app.js`, `store.js`, `share.js`, `supabase-config.js`, `tmdb-config.js`), run `python tools/bump-version.py`. It rewrites the `?v=` cache-busting stamps in every HTML page and `VERSION` in `sw.js`. Without it, deployed clients keep serving stale files.

## Architecture

- **`app.js`** (~2100 lines, dense style) holds nearly all the logic: rendering, filtering and sorting, the edit dialog, work-search autofill, import/export, sync and sharing. It exposes globals (`normalizeItem`, `mergeItems`, `visible`, `render`, `window.appReady`, …) that the tests call directly.
- **`store.js`** (`LocalStore`): the IndexedDB wrapper with `items`, `covers` (Blobs keyed by SHA-256) and `meta` stores. If IndexedDB is unavailable, `app.js` falls back to legacy localStorage (`storeMode`: `loading` → `idb` | `legacy`). Schema upgrades must be additive inside `onupgradeneeded`.
- **`share.html` / `share.js`**: the read-only viewer for share links, fetched via the `get_share` RPC.
- **`theme.js`**: applies the theme before first paint and hides content when the page is framed (clickjacking defense, since GitHub Pages can't send headers).
- **`sw.js`**: a stale-while-revalidate Service Worker. Versioned assets are cached under their exact `?v=` URL, so an old `app.js` is never paired with a new page.
- **`supabase-schema.sql`**: tables, RLS, triggers (`guard_library_item`) and RPCs (`get_share`, `purge_expired_shares`, `delete_my_account`), plus per-user and global free-tier quotas. The owner runs it by hand in Supabase, so changes there aren't deployed by a push. Client code must tolerate sections that haven't been run yet (for example, it falls back to embedded covers if Storage isn't set up).

### Sync model (spans app.js and the schema)

- Local-first: `commit` writes to IndexedDB first, then pushes to the cloud. Failed IDs go into a pending set (localStorage `yokattana-pending`), which `flushPending` retries.
- Last-write-wins per record on `updatedAt` (`mergeItems`). Future timestamps are clamped on both the client (`normalizeItem`) and the server (`guard_library_item`).
- Deletes are tombstones (`deleted: true`): content stays 30 days in the trash, after which `emptyOf` / `compactTrash` empties it, and the marker itself is dropped after 90 days.
- Covers are stored apart from records. A record holds `{ hash }`, and the cover file is uploaded to the Storage `covers/` bucket before the record is pushed. Records in the current format carry `format: 2`, and the DB rejects writes that lack it (this protects against older app versions). `loadCloudItems` migrates legacy embedded-cover rows on login.
- `finishLogin` tracks the device owner (`yokattana-owner`) so one account's records never leak into another account.

### Security constraints to preserve

- The CSP in each HTML `<meta>` includes Trusted Types (`require-trusted-types-for 'script'`). Never assign strings to `innerHTML` or similar sinks. Use `textContent` and DOM APIs. The only Trusted Types policy is `yokattana` in `app.js`, and it allows only NDL XML parsing and registering `sw.js`.
- Adding a new external API or image host means updating the `connect-src` / `img-src` allowlist in the CSP of every page that needs it.
- supabase-js is pinned and loaded with SRI from jsDelivr. If you change its version, update the `integrity` hash and `SUPABASE_JS` in `sw.js` too.
- External cover images are re-drawn on a canvas into data URLs or Blobs (`fetchCover`). External image URLs are never stored.

## Tests

`tests/index.html` loads the real `index.html` body, replaces Supabase with `tests/fake-cloud.js` (an in-memory fake that can also simulate failures), uses a separate IndexedDB named `yokattana-test`, and then loads `store.js`, `app.js` and `share.js` before the test files. The harness (`tests/harness.js`) is homemade: `test(name, fn)`, `eq(actual, expected)` and `assert(cond)`. Tests run against real IndexedDB in real time, without virtual time. Network calls in feature tests are stubbed by replacing `fetch`.

## Docs

`README.md` (user-facing behaviour and limits) and `docs/TECHNOLOGY.md` (a technology map with `file:line (function)` references) are both in Japanese. When you change behaviour they describe, update them. Line numbers in TECHNOLOGY.md drift, so search by function name.
