# クラウド同期の初期設定

この設定を行うと、同じアカウントでログインした端末からプロジェクトを引き続き編集できます。利用者側にPythonやNode.jsは必要ありません。

クラウド同期では原稿が端末外へ保存されます。未発表原稿、個人情報、輸出管理対象などを含む場合は、先に所属組織の規程を確認してください。Supabaseへの保存はエンドツーエンド暗号化ではありません。組織が外部サービスを許可しない場合は、クラウド同期を有効にせず、現在の端末内保存と暗号化したバックアップを利用してください。

## 最短の設定手順

管理者が最初に一度だけ、次の5項目を行います。詳しい画面名と安全確認は、この後の各節にあります。

1. Supabaseで専用プロジェクトを作り、`supabase/schema.sql`をSQL Editorで実行する。
2. Email認証を有効にし、新規登録と匿名ログインを無効にして、利用者を個別招待する。
3. Magic Linkメールへ `{{ .Token }}` を入れ、GitHub Pagesの正確なURLだけを許可する。
4. Project URLとPublishable keyだけを`scripts/cloud-config.js`へ記入する。
5. GitHub Pagesを公開し、対象プロジェクトを1件ずつ「クラウドへコピー」する。

Secret key、`service_role` key、データベースパスワードは、どのファイルにも記入しません。

## 1. Supabaseプロジェクトを作る

1. [Supabase](https://supabase.com/)でプロジェクトを1つ作ります。
2. Dashboardの「SQL Editor」で新しいクエリを開きます。
3. [`supabase/schema.sql`](../supabase/schema.sql)の内容をすべて貼り付けて実行します。
4. 「Storage」で `paper-assets` が **Private** になっていることを確認します。Publicへ変更しないでください。

SQLは同じプロジェクトで再実行できます。`projects` テーブルには本人の原稿だけを許可する[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)が設定され、添付ファイルは本人のユーザーIDで始まる保存先だけに制限されます。ログイン中のブラウザーにもテーブルの直接追加・更新・削除権限は与えず、所有者と版番号を検証する専用RPCだけが変更を行います。

## 2. ログインの戻り先を設定する

Supabase Dashboardの「Authentication」→「URL Configuration」で次を設定します。

- **Site URL**：公開したGitHub Pagesの正確なURL
- **Redirect URLs**：同じGitHub Pages URL

例えば `https://example.github.io/paper-tools/` です。末尾の `/` を含め、実際のURLをそのまま登録します。本番環境では `*` や `**` を使った広い許可を避けてください。詳しくはSupabase公式の[Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)を参照してください。

「Authentication」→「Providers」でEmailを有効にします。このアプリは、別画面へ移動するマジックリンクではなく、メールに届いたワンタイムコード（OTP）を画面へ入力する方式を使用します。

公開サイトから誰でもアカウントを作れる状態にしないことを推奨します。「Authentication」の一般設定で **Allow new users to sign up** を無効にし、**Allow anonymous sign-ins** も無効のままにします。利用を許可する人は、管理者が「Authentication」→「Users」→「Add user」→「Send invitation」からメールアドレスを個別に招待します。招待後、その利用者は通常のOTPログインを使用できます。詳しくはSupabase公式の[General configuration](https://supabase.com/docs/guides/auth/general-configuration)と[Inviting users](https://supabase.com/docs/guides/auth/users#inviting-users)を参照してください。

アプリからOTPを送る処理も、新規利用者を自動作成しない `shouldCreateUser: false` を使用します。これは画面側の誤操作対策であり、Supabase側の新規サインアップ無効化も併用してください。

続いて「Authentication」→「Email Templates」→「Magic Link」を開き、本文中に `{{ .Token }}` を入れて、確認コードが表示されるテンプレートにします。`{{ .ConfirmationURL }}` だけのテンプレートでは、アプリへ入力するコードが表示されません。例えば本文を「Paper Toolsの確認コードは `{{ .Token }}` です。このコードを他人へ伝えないでください。」とします。テンプレート変数はSupabase公式の[Email Templates](https://supabase.com/docs/guides/auth/auth-email-templates)でも確認できます。

「Invite user」テンプレートは招待受諾用のため、`{{ .ConfirmationURL }}` を残します。OTP用に変更するのは「Magic Link」テンプレートです。

GitHub PagesはHTTPSで公開してください。`file://` で直接開いたHTMLは端末内モードには使えますが、安全で安定したログイン元にはできません。

GitHub Pagesの保存領域はURLのパスではなく、`scheme + host + port`からなる**オリジン**単位です。例えば`https://USER.github.io/app-a/`と`https://USER.github.io/app-b/`は同じオリジンで、別リポジトリのJavaScriptから同じIndexedDBへ到達できます。機密原稿には、このアプリ専用のカスタムドメイン（例：`papers.example.org`）か、このアプリ専用のGitHubアカウント／Organizationを使用してください。同じ`USER.github.io`配下に信頼できないPagesサイトを置かないでください。

## 3. アプリに接続情報を設定する

Supabase Dashboardの「Project Settings」→「API」から、次の2つだけを使用します。

- Project URL
- `sb_publishable_...` で始まるPublishable key

Publishable keyはブラウザー用の低権限キーで、RLSとログイン中のユーザー情報を組み合わせて使います。キーの種類はSupabase公式の[Understanding API keys](https://supabase.com/docs/guides/getting-started/api-keys)も参照してください。

次の情報は、HTML、JavaScript、GitHub、スクリーンショットへ絶対に入れないでください。

- Secret key
- `service_role` key
- データベースのパスワードや接続文字列

Secret keyと`service_role` keyはRLSを迂回できるため、ブラウザーで使用すると全利用者のデータ漏えいにつながります。誤って公開した場合は、Supabase側で直ちにキーを無効化・再発行してください。

`scripts/cloud-config.js`を開き、次の3項目だけを変更します。

```js
window.PAPER_TOOLS_CLOUD = Object.freeze({
  enabled: true,
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  publishableKey: "sb_publishable_...",
});
```

次に`index.html`先頭のContent Security Policyにある`connect-src`を、本番ではプロジェクト固有のホストへ狭めます。

```html
connect-src 'self' https://YOUR_PROJECT_REF.supabase.co
```

既定の`https://*.supabase.co`でも動作しますが、プロジェクト固有ホストに限定すると、万一ページ内スクリプトが侵害された場合の持出し先を減らせます。設定後にGitHubへpushし、Pagesを再公開します。Publishable keyは公開される前提ですが、RLSの確認前に原稿を同期しないでください。

## 4. 初回の移行

1. これまで使用していた`file://`版で、各プロジェクトを開き、1件ずつZIPバックアップを作ります。
2. GitHub Pages版を開き、「バックアップを読み込む」から各ZIPを取り込みます。`file://`版とHTTPS版は別のブラウザー保存領域なので、この操作が必要です。
3. GitHub Pages版で原稿と添付を確認してから、メールOTPでログインします。
4. 左メニューの「端末間同期」を開き、対象プロジェクトの「クラウドへコピー」を1件ずつ実行します。
5. 別の端末でログインし、一覧表示、原稿の再表示、添付ファイルの表示を確認します。
6. 確認が終わるまで、元の端末内データとZIPバックアップを削除しないでください。

移行はプロジェクトごとに行われます。すでに同じIDのクラウド版がある場合は自動上書きせず、競合として止めます。どちらを残すか確認してから、不要な側を別名で複製するか、最新の版を読み直して保存してください。

## 5. 日常の安全な使い方

- ログアウトはクラウド認証だけを終了し、端末内の原稿を削除・暗号化・ロックしません。共有端末では本アプリを使用しないか、ZIPバックアップを確認した後に端末内プロジェクトを削除します。ブラウザーの「サイトデータを削除」は同じ`USER.github.io`上の別Pagesアプリにも影響し得るため、専用ドメインでない場合は対象範囲を確認してから行います。
- ブラウザーやOSを最新に保ち、メールアカウントにも多要素認証を設定します。
- 公共Wi-Fiでも必ずGitHub PagesのHTTPS URLから開きます。
- 大きな節目ごとにZIPバックアップを作り、暗号化した別媒体へ保管します。
- クラウドから削除する前に、必要な原稿と添付がバックアップに含まれることを確認します。

プロジェクト本体と添付ファイルは別の保存場所です。初期版の画面では、添付を持つクラウドプロジェクトの削除を意図的に行いません。Storage削除とデータベース削除は1つのトランザクションにできず、途中で競合すると添付だけを失う危険があるためです。データベース側も `payload.assets` が空でない削除を `attachments_present` として拒否します。添付を先に消してこの検査を迂回しないでください。端末内の削除もクラウドへ自動反映しません。クラウド側を整理する前にバックアップを作り、管理者がSupabase Dashboardで対象所有者と保存先を確認してください。

## 保存・競合処理の仕様

アプリからプロジェクトを保存するときは、通常のテーブル更新ではなく `save_project` RPCを使用します。

```js
const { data, error } = await supabase.rpc("save_project", {
  p_project_id: project.id,
  expected_revision: localRevision,
  new_payload: projectWithoutBinaryAssets,
});
```

新規作成時の `expected_revision` は `0` です。成功後は返された `revision` を次回保存に使用し、返された `cloud_id` を添付ファイルの保存先に使用します。`cloud_id` はデータベースが発行するため、端末側で作成・変更しません。

| `status` | 意味 | アプリ側の処理 |
| --- | --- | --- |
| `saved` | 新規作成または保存に成功 | 返された版番号を保持する |
| `conflict` | 別端末が先に保存済み | 上書きせず、クラウド最新版を読み直す |
| `not_found` | 対象がない、または削除済み | 自動再作成せず利用者へ確認する |

RPCは「確認した版番号と現在の版番号が同じ場合だけ更新」をデータベース内で一度に行います。競合時に原稿本文を応答へ含めないため、他人のデータの有無や内容は返りません。

添付のないプロジェクトを削除するときも、テーブルを直接削除せず専用RPCを使用します。

```js
const { data, error } = await supabase.rpc("delete_project", {
  p_project_id: project.id,
  expected_revision: localRevision,
});
```

| `status` | 意味 | アプリ側の処理 |
| --- | --- | --- |
| `deleted` | 添付がなく、版番号も一致して削除に成功 | 端末内の同期情報を消す |
| `attachments_present` | 添付メタデータが残っている | 削除せず、初期版では利用者へ制限を表示する |
| `conflict` | 別端末が先に更新済み | 削除せず、クラウド最新版を読み直す |
| `not_found` | 対象がない、または削除済み | 自動再作成せず利用者へ確認する |

`delete_project` は対象行をロックしたまま版番号と `payload.assets` を検査します。`assets` が明示的な空配列でない場合、項目の欠落、`null`、不正な形式の場合も削除しません。

添付ファイルは、次の形式のパスだけを使用します。端末内のプロジェクトIDをパスに直接使いません。

```text
{ログイン中のユーザーUUID}/{DBが発行したcloud_id}/{添付のRFC 4122 UUID}/payload.{安全な拡張子}
```

例：

```text
11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/payload.csv
```

通常の添付ID `asset_<UUID>` から、`<UUID>` 部分だけを第3階層に使います。元のファイル名と端末内プロジェクトIDはパスへ入れません。UUID形式でない旧式・取り込み由来の添付IDは安全のため同期を停止し、アプリ上で添付し直して新しいIDを発行します。許可する拡張子は `png`、`jpg`、`jpeg`、`pdf`、`csv`、`json`、`txt`、`yaml`、`yml` だけです。

アプリは1ファイル20 MiBまで、Storageは防御上限として50 MiBまでに制限し、MIME typeも画像、PDF、CSV、JSON、テキスト、YAMLの許可リストに限定します。初期版では、ログイン利用者は本人の添付を新規アップロード・取得できますが、アップロード後の上書きと削除はできません。プロジェクトIDは英数字で始まる最大120文字で、使用できる文字は英数字、`_`、`-` だけです。プロジェクトのJSON payloadはデータベース側でも4 MiBまでに制限され、payload内の `id` は保存対象のプロジェクトIDと一致しなければなりません。添付本体を `projects.payload` に埋め込まず、payloadには添付ID、表示名、種類、サイズなどのメタデータだけを保存します。添付IDとファイルの対応はpayload内の `assets` 情報で保持します。

## 設定後の確認

- ログアウト中はプロジェクト一覧と添付を取得できない
- アカウントAの原稿をアカウントBから取得・更新・削除できない
- ログイン中でも `projects` テーブルを直接追加・更新・削除できない
- 添付URLは公開URLではなく、ログイン中の本人だけが取得できる
- 2端末で同じ原稿を開き、片方を先に保存すると、もう片方は競合表示になる
- 添付メタデータがあるプロジェクトの削除は `attachments_present` になる
- GitHubリポジトリにSecret key、`service_role` key、データベース接続文字列がない

RLSは認可の最後の防壁ですが、ログイン用メールや端末そのものが乗っ取られた場合までは防げません。極めて機密性の高い研究には、所属組織が管理するSupabase／PostgreSQL環境または承認済みのストレージを使用してください。
