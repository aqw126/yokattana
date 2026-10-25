# 使っている技術と、その役割

「よかっ棚」を作り、運営するために使っている技術を、役割と、実際のコードの場所つきでまとめた、学習用のメモです。

- 行番号は **2026-10-25 時点**のものです。コードが変わるとずれるので、見つからないときは、**関数名で検索**してください。
- 場所の書き方は、`ファイル名:行番号（関数名）` です。

## 全体像

```
利用者のブラウザ（PC・スマホ）
 ├─ HTML / CSS / JavaScript   … 画面と動作のすべて（フレームワークなし）
 ├─ localStorage              … 記録の保存先（まずここに保存）
 ├─ Service Worker            … オフライン対応
 └─ supabase-js（ライブラリ） … クラウドとの通信
        │ HTTPS
        ▼
GitHub Pages ……… 画面のファイルを配信（静的ホスティング）
Supabase ………… ログイン・データベース・API（バックエンド）
Google ………… ログイン（OAuth）／ 所有確認（Search Console）
GitHub ………… ソースの管理・自動テスト・定期実行（Actions）
```

自分で書いたサーバー側のプログラムはありません。画面は静的なファイルで、データの置き場所とログインは Supabase が担います。この構成を **サーバーレス**、または **BaaS（Backend as a Service）** と呼びます。

---

## 1. 画面側（フロントエンド）

| 技術 | 役割 | 場所 |
|---|---|---|
| **HTML5** | 画面の骨組み。`<dialog>`（モーダル）、`<details>`（開閉）、`<template>`（カードの雛形）、`<main>` などの意味を持つ要素 | `index.html`（カードの雛形 `:457`、共有ダイアログ `:323`） |
| **CSS カスタムプロパティ** | 配色を変数にまとめ、差し替えでダークモードを実現 | `styles.css:1`（`:root`）、`:693`（ダーク） |
| **CSS メディアクエリ** | スマホ幅、ダーク設定、「動きを減らす」設定への対応 | `styles.css:452`（スマホ）、`:688`（動きを減らす）、`:716`（ダーク設定） |
| **CSS `:focus-visible`** | キーボード操作時の枠線 | `styles.css:681` |
| **JavaScript（素のまま）** | すべての動作。ビルドも外部の枠組みもなし | `app.js`（記録）、`share.js`（共有ページ）、`theme.js`（テーマ） |
| **localStorage** | ブラウザ内の保存領域（約5MB）。記録の本体の置き場所 | `app.js:1`（キー名）、`save()`、`load()` |
| **Canvas API** | 表紙画像を、長辺600pxのJPEGに縮小 | `app.js:261`（`scaleImage`）、`:277`（`readCover`） |
| **Blob / URL.createObjectURL** | JSON・CSV をファイルとして書き出す | `app.js:539`（`backup`）、`:675`（`exportCsv`） |
| **TextDecoder** | UTF-8 で読めなければ Shift_JIS で読み直す | `app.js:745`（`readText`） |
| **Web Crypto** | 記録のID（`randomUUID`）と、共有リンクの乱数（128ビット） | `app.js:229`、`:1082`（`makeShareToken`） |
| **Clipboard / Web Share API** | リンクのコピーと、スマホの共有メニュー | `app.js:1134`（`copyText`） |
| **Intl.DateTimeFormat** | 日本語の日付表示 | `app.js` の `date()` |
| **Web App Manifest** | ホーム画面に追加するときの名前・アイコン | `manifest.webmanifest` |
| **Service Worker** | 通信を仲介し、オフラインでも開けるようにする | `sw.js:21`（install）、`:30`（activate）、`:38`（fetch）、登録は `app.js:1233` |

### 画面の描画のしかた
- フレームワークを使わず、`render()` が、記録の配列から、カードを作り直します（`app.js:372`）。
- 表示用の文字は、`textContent` で入れます。HTML として解釈させないことで、XSS を防ぎます。
- 並べ替えは `compareItems`（`app.js:359`）、絞り込みは `visible`（`app.js:352`）。

---

## 2. バックエンド（Supabase）

Supabase は、PostgreSQL を中心にした、オープンソースの BaaS です。

| 要素 | 役割 | 場所 |
|---|---|---|
| **PostgreSQL** | データベース本体。表は `library_items`（記録）と `shares`（共有） | `supabase-schema.sql:1`、`:49` |
| **jsonb** | 記録の中身を、JSON のまま1列に保存できる型。項目を増やしても、表を変えずに済む | `library_items.payload` |
| **Auth** | ログインの管理。Google でログインすると、**JWT**（本人の証明書）が発行され、ブラウザに保存される | `app.js:161`（`onAuthStateChange`）、`:163`（`getSession`） |
| **PostgREST** | 表を、自動で REST API にする仕組み。`from('...').upsert()` は、この API を呼んでいる | `app.js:66`（記録の送信）、`:102`（取得）、`:1162`（共有の作成） |
| **RLS（行レベルセキュリティ）** | 「自分の行だけ読み書きできる」を、データベース側で強制 | `supabase-schema.sql:11`〜（記録）、`:61`〜（共有） |
| **RPC（SQL 関数）** | `get_share()`（共有の閲覧）、`delete_my_account()`（退会） | `supabase-schema.sql:91`、`:30` |
| **`security definer`** | 関数を、呼んだ人ではなく、持ち主の権限で動かす指定。使う場合は `search_path` の固定が必須 | `supabase-schema.sql:30`、`:91` |
| **トリガー** | 共有の作成前に、件数（50件）を確認 | `supabase-schema.sql:74`（`limit_shares`） |
| **外部キー + `on delete cascade`** | アカウントを消すと、記録と共有も連動して消える | `supabase-schema.sql:3`、`:51` |
| **supabase-js** | ブラウザから Supabase を呼ぶ公式ライブラリ | `index.html:492`、`app.js` の `cloud` |
| **publishable key** | ブラウザに置いてよい公開用の鍵。守りは RLS が担う | `supabase-config.js` |

---

## 3. ログインまわり

| 技術 | 役割 | 場所 |
|---|---|---|
| **OAuth 2.0（Google）** | パスワードを預からず、Google に本人確認を任せる | `app.js:183`（`signInWithGoogle`） |
| **ログイン後の処理** | 別アカウントの記録を混ぜない確認、クラウドとの統合 | `app.js:131`（`finishLogin`） |
| **ログアウト** | 端末の記録と、所有者の印を消す | `app.js:146`（`applySignedOut`） |
| **退会** | RPC を呼び、クラウドのアカウントごと削除 | `app.js:798`（`deleteAccount`） |
| **Google Search Console** | サイトの所有確認（同意画面の公開に必要） | `index.html` の `google-site-verification` |

---

## 4. 同期の仕組み（設計の要）

| 考え方 | 内容 | 場所 |
|---|---|---|
| **ローカルファースト** | 先に localStorage へ保存し、あとからクラウドへ送る。通信が切れても使える | `app.js:530`（`commit`） |
| **Last-Write-Wins** | 記録ごとの `updatedAt` を比べ、新しい方を採用 | `app.js:55`（`mergeItems`） |
| **トゥームストーン（削除の印）** | 行を消さず、`deleted: true` を付けて、他の端末にも削除を伝える | `app.js:202`（`emptyOf`） |
| **ごみ箱** | 30日は中身を残し、過ぎたら中身だけ消す。90日で印も消す | `app.js:206`（`compactTrash`）、`:829`（`renderTrash`） |
| **同期待ちと再送** | 失敗した記録のIDを控え、接続の復帰・1分ごと・タブを開いたときに再送 | `app.js:90`（`flushPending`） |
| **まとめて送る** | 20件ずつ送信 | `app.js:60`（`syncItems`） |
| **ページ分けの取得** | 100件ずつ全件を読む（取得上限を超えないため） | `app.js:99`（`fetchRemoteItems`） |
| **ログイン時の統合** | クラウドと手元を合わせ、差分だけ送る | `app.js:108`（`loadCloudItems`） |
| **別のタブの変更の取り込み** | `storage` イベントで検知 | `app.js:1237` |

---

## 5. データの出し入れ

| 機能 | 場所 |
|---|---|
| 記録の正規化（壊れたデータを整える。XSS 対策も兼ねる） | `app.js:223`（`normalizeItem`） |
| JSON の書き出し・読み込み | `app.js:539`（`backup`）、`:750`（`importJson`） |
| CSV の書き出し（数式の実行を防ぐ印つき） | `app.js:669`（`csvCell`）、`:675`（`exportCsv`） |
| CSV の読み込み（引用符・改行・見出しの名前の違いに対応） | `app.js:685`（`parseCsv`）、`:727`（`csvItems`）、`:768`（`importCsv`） |
| ジャンル・タグの整理（名前の変更・まとめ・削除） | `app.js:916`（`applyBulk`）、`:923`（`renameOption`） |
| 振り返り（集計と棒グラフ） | `app.js:959`（`drawBars`）、`:984`（`drawReview`） |

---

## 6. 共有リンク

| 要素 | 内容 | 場所 |
|---|---|---|
| 共有の中身を作る | ネタバレの扱い（含めない／ネタバレなしだけ／すべて）に応じて、メモと引用を出し入れ。表紙・ID・メールは含めない | `app.js:1087`（`sharePayload`） |
| リンクの文字列 | 128ビットの乱数を base64url に | `app.js:1082`（`makeShareToken`） |
| 作成・一覧・停止 | `shares` への挿入、取得、削除 | `app.js:1153`（`createShare`）、`:1175`（`loadMyShares`） |
| 手動で選ぶ | 選択のモード、選択の保持、並び順の維持 | `app.js:1049`（`pickedItems`）、`:1064`（`setPicking`） |
| 閲覧ページ | `share.html#<リンクの文字列>` を読み、RPC で取得して表示。すべて `textContent` | `share.js:60`（`loadShare`）、`:21`（`renderShare`） |
| ネタバレの隠し方 | ネタバレありの記録は、閉じた `<details>` に入れる | `share.js` の `renderShareItem` |
| 閲覧ページの安全策 | 検索除外、参照元を送らない、通信先の限定、SRI | `share.html` の `<head>` |

---

## 7. セキュリティ

| 脅威 | 対策 | 場所 |
|---|---|---|
| 他人のデータを見られる | RLS | `supabase-schema.sql` |
| スクリプトの注入（XSS） | `textContent`、HTMLのエスケープ、表紙は画像のdata URLだけ許可 | `app.js:2`（`COVER` の正規表現）、`:223`（`normalizeItem`）、`preview`（`:433`） |
| 外部スクリプトの改ざん | バージョン固定と **SRI**（`integrity` 属性） | `index.html:492` |
| 想定外の通信・実行 | **CSP**（読み込み・通信先の許可リスト） | `index.html:15` |
| 共有リンクの推測 | 128ビットの乱数。一覧は取れず、IDを知る人が1件だけ読める | `get_share`（`supabase-schema.sql:91`） |
| CSV の数式実行 | `=` `+` `-` `@` で始まるセルに印 | `app.js:669`（`csvCell`） |
| 乱用 | 共有は1人50件、100件まで、1MB未満 | `supabase-schema.sql:49`〜 |
| 別アカウントへの混入 | 端末の所有者を記録し、違えば破棄 | `app.js:131`（`finishLogin`） |

---

## 8. 見た目・使いやすさ

| 項目 | 内容 | 場所 |
|---|---|---|
| ダークモード | 自動・ライト・ダークの切り替え。選択は localStorage に保存。描画前に反映してちらつきを防ぐ | `theme.js`、`app.js:555`（`applyTheme`） |
| アクセシビリティ | `aria-label`、`aria-labelledby`、本文へ移動するリンク、色の対比（4.5:1）、大きなタップ領域 | `index.html:22`、`styles.css:681` |
| お知らせ（トースト） | 開いているダイアログの中に出す（背後に隠れないため） | `app.js:28`（`showToast`） |
| 状態表示 | オフライン、同期待ち、同期中 | `app.js:37`（`updateSyncStatus`） |

---

## 9. 配信と運用

| 技術 | 役割 | 場所 |
|---|---|---|
| **GitHub Pages** | 静的ファイルを無料で配信（HTTPS）。ブラウザの保存期間が10分あるため、`?v=` の印で更新を確実にする | リポジトリの設定 |
| **Git / GitHub** | 変更履歴。ブランチを切り、プルリクエストで確認してマージ | — |
| **GitHub Actions** | `test.yml`：変更のたびにテスト。`keepalive.yml`：週1回、Supabase に接続して、無料枠の自動停止を防ぐ | `.github/workflows/` |
| **jsDelivr（CDN）** | supabase-js の配信元 | `index.html:492` |
| **キャッシュ回避の印** | `?v=...` と、Service Worker のバージョンを、一括で更新 | `tools/bump-version.py` |
| **Python** | 補助の道具。バージョン更新と、テストの実行 | `tools/`、`tests/run.py` |

---

## 10. テスト

| 要素 | 役割 | 場所 |
|---|---|---|
| **自作のテスト基盤** | 外部のテスト用ソフトを使わず、`test()` / `eq()` / `assert()` だけで書く | `tests/harness.js:4`〜 |
| **実行ページ** | 本物の `index.html` と `app.js` を読み込み、Supabase だけ偽物に差し替える | `tests/index.html` |
| **偽の Supabase（モック）** | メモリ上の表。失敗の再現（通信エラー）も可能 | `tests/fake-cloud.js` |
| **動作テスト** | 正規化、統合、ごみ箱、CSV、同期、アカウント切り替えなど | `tests/app.test.js` |
| **機能テスト** | 引用・ネタバレ、共有、閲覧ページ、オフライン、コピー、手動選択 | `tests/feature.test.js` |
| **アクセシビリティのテスト** | 名前の有無、見出し、色の対比（ライト・ダーク）、フォーカス | `tests/a11y.test.js` |
| **ヘッドレス Chrome での実行** | Python で簡易サーバーを立て、画面なしの Chrome で開き、結果を読む | `tests/run.py:45`（`main`） |
| **CI** | GitHub 上で、変更のたびに自動実行 | `.github/workflows/test.yml` |

テストの実行:

```
python tests/run.py
```

---

## 11. 費用
この使い方では、次はすべて無料です。GitHub Pages、Supabase の無料枠、Google の OAuth、GitHub Actions。ドメインは `github.io` のものを使っています。

## 12. 学ぶ順番のおすすめ
1. **HTML / CSS / JavaScript の基本**：`index.html`、`styles.css`、`app.js` を、上から読む。
2. **ブラウザの API**：localStorage、Canvas、Service Worker、Clipboard。
3. **Git と GitHub**：ブランチ、プルリクエスト、Actions。
4. **SQL と PostgreSQL**：`supabase-schema.sql` を読み、表、jsonb、関数、トリガーを理解する。
5. **認証と認可**：OAuth、JWT、RLS。
6. **セキュリティ**：XSS、CSP、SRI。
7. **テスト**：`tests/` を読み、モックの考え方を理解する。
