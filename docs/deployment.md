# Workers・D1 初回公開手順

この手順は空の本番DBから開始する場合のものです。ローカルの本棚は移行しません。作業ディレクトリはリポジトリ直下、PowerShellを想定しています。Cloudflare上での作成・秘密登録・公開は、この文書を作成した時点では未実施です。

## 1. アカウントと提供URL

Cloudflareアカウントを用意し、Workers Freeを使用します。Workers & Pagesで自分のworkers.devサブドメインを確認・設定します。Worker名をchaos-novelとする場合、提供URLは `https://chaos-novel.<あなたのサブドメイン>.workers.dev` です。独自ドメインは不要です。

```powershell
npm ci
npx wrangler login
npx wrangler whoami
npx wrangler d1 create chaos-novel-db
```

ログイン画面で対象アカウントを確認します。複数アカウントがある場合は対象のaccount_idをwrangler.jsoncに指定してください。D1作成で返るdatabase_idを次の設定で使用します。DB名は初期化スクリプトと同じchaos-novel-dbを維持します。

## 2. 本番設定

wrangler.jsoncの**トップレベル**を変更します。env.localは変更しません。

| 項目 | 設定 |
| --- | --- |
| name | chaos-novel |
| d1_databasesのDBのdatabase_id | 作成した本番D1のID |
| vars.PUBLIC_ORIGIN | 実際の提供URL。末尾の / は付けない |
| vars.COOKIE_SECURE | "1" |
| vars.MAX_ACTIVE_NOVELS | 初期運用例 "20"。最新AGENTS.mdは10〜20冊程度を想定。コードの未指定時既定値は30 |
| vars.ENABLED_CAPACITIES | "4000,12000" |

LOCAL_DEVは本番に設定しません。管理者は区分設定に関係なく長編も作れますが、冊数上限には従います。既存長編の閲覧・投稿には区分設定を適用しません。

```powershell
npm run check:deploy
```

このコマンドはネットワークアクセス・公開をせず、仮URL・仮DB ID・設定不備を検出します。現在のリポジトリの仮設定のままなら失敗するのが正常です。Cloudflare上のDBの存在、マイグレーション状態、秘密の登録内容までは検査しません。

## 3. 本番D1初期化（初回のみ）

以下は本番DBを書き換えるコマンドです。初回はWorker公開前に実行します。既存本番DBに適用する場合は、先に書き込みを停止してバックアップしてください。

```powershell
npx wrangler d1 migrations apply chaos-novel-db --remote
npm run workers:rekey -- --remote --maintenance-confirmed
npx wrangler d1 execute chaos-novel-db --remote --command "SELECT value FROM app_meta WHERE key='title_key_version'; SELECT count(*) AS books FROM novels;"
```

0001〜0004のすべてを適用します。**空のDBでもworkers:rekeyが必要です。** 0002直後はタイトルキーの版がpending:2で、新規公開が止まっています。初期化後は `2:<NodeのUnicode版>` になり、booksが0であることを確認します。既存DBへのrekeyは、通常の毎回のデプロイでは行いません。比較規則・ランタイムのUnicode版変更時だけREADMEの移行手順に従います。

同じPowerShellでCLOUDFLARE_ENV等による環境の上書きを設定していないことを確認してください。本番コマンドに `--env local` を付けないでください。Node版のschema.sqlはD1へ適用しません。

## 4. 本番の秘密情報

パスワード管理ソフト等で、互いに異なる十分長いランダムな値を用意します。

- ADMIN_PASSWORD：12文字以上。用意した64文字のランダム英数字を使用できます。
- COOKIE_SECRET：32文字以上のランダムな値。管理者パスワードとは別の値にし、DBバックアップと別管理します。公開後に変更すると参加者Cookieが無効になるため、固定して保管します。

初回はプロジェクト直下に `.dev.vars.production` を自分のエディタで作成します（このファイル名はGit除外済み）。値をチャットやコマンド引数、wrangler.jsoncに貼り付けないでください。

```dotenv
ADMIN_PASSWORD=ここを本番用ランダム値に置き換える
COOKIE_SECRET=ここを別の本番用ランダム値に置き換える
```

このファイルには上記2項目だけを書きます。開発用の.dev.vars.localを流用しません。ローカル設定は自動で本番に登録されません。次のdeployコマンドの--secrets-fileでコードと一緒に秘密を登録します。

## 5. 検証してから公開

```powershell
npm test
npm run check:workers
npm run check:deploy
```

check:workersはバンドルのdry-runで公開しません。Windowsのブラウザで縦書き・日本語IME、スマホで閲覧と入力を確認してから公開してください。

**次のコマンドが実際の公開です。** 提供URLから誰でもアクセス可能になります。

```powershell
npm run deploy:workers -- --secrets-file .dev.vars.production
```

本番設定を検査し、画面の最新ファイルをビルドしてから、トップレベル環境へ公開します。初回公開後、秘密はCloudflare側に保存されます。ローカルの本番秘密ファイルを安全な保管先へ移した後も、次回は `npm run deploy:workers` だけで登録済み秘密を維持して更新できます。秘密を変更するときは `npx wrangler secret put ADMIN_PASSWORD` 等の対話入力も使用できます。

通常更新でD1を新規作成・初期化し直さないでください。必要な追加マイグレーションがある場合だけ、バックアップと停止手順を確認して適用します。Gitへのpushだけでは公開されません（自動デプロイは未設定）。

## 6. 公開後の確認と無料枠

- 提供URLと `/api/session` が成功し、ゲストのcreation.capacitiesが[4000,12000]であること。
- 新規ブラウザではゲストで、管理者ログイン後だけ長編も選べること。
- 一冊作成→別ブラウザから投稿→管理者で執筆終了→全文閲覧を確認すること。確認用の本の削除は管理者操作で行えます。
- 再読み込みしても本文・参加制限が維持されること。
- CloudflareのWorkers/D1のメトリクスでリクエスト数、CPU時間、読み取り・書き込み行数を確認すること。

確認時点のFree枠はWorkersが1日10万リクエスト・1回CPU 10ms、D1が1日500万行読み取り・10万行書き込み・合計5GBです。無料枠内で動く人数をローカルテストだけでは保証できません。完結した本も保存容量を使うため、執筆中の冊数上限はDB全体の保存量制限ではありません。最初は少人数で実測します。

公式資料（公開時にも確認）：[workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)、[D1コマンド](https://developers.cloudflare.com/d1/wrangler-commands/)、[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)、[D1料金](https://developers.cloudflare.com/d1/platform/pricing/)。
