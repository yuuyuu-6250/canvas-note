# Canvas Note

ブラウザで動く、無限キャンバスの手書きノートです。iPad + Apple Pencil や、ペンタブレット付きの PC での利用を想定しています。

- ペン（筆圧対応）・マーカー・消しゴム・投げ縄（移動・拡大縮小・回転・色変え・複製）
- 定規（直線・関数 y = f(x)・媒介変数 x = f(t), y = g(t)）
- 画像・PDF の取り込み、PNG 書き出し（選択範囲だけも可）、JSON バックアップ
- テンプレート（よく使う図を保存して一発で呼び出す）
- ボードのフォルダ分け、ダークモード、オフライン対応（ホーム画面に追加して使える）
- Google ログインでのクラウド同期（Firebase、任意）

ビルドは不要です。HTML / CSS / JavaScript のファイルを置くだけで動きます。

---

## 自分用に構築する

### 0. ソースを手に入れる

次のどちらかで手に入れます。

- **配布用 zip**（おすすめ）：[canvas-note.zip](https://yuuyuu-6250.github.io/canvas-note/dist/canvas-note.zip) をダウンロードして展開する。自分用の設定が空になった状態で入っています。
- **このリポジトリ**：GitHub の「Fork」か「Code → Download ZIP」。この場合、`firebase-config.js` と `firestore.rules` には作者の設定が入っているので、手順 2・3 で必ず書き換えてください。

### 1. まずは同期なしで動かしてみる（任意）

`firebase-config.js` の `window.FIREBASE_CONFIG = null;` のままなら、ログイン画面は出ず、ノートはその端末のブラウザの中だけに保存されます。

Service Worker を使うので、ファイルを直接ダブルクリックで開くのではなく、簡単なサーバー経由で開きます。

```sh
cd canvas-note
python -m http.server 8000
```

ブラウザで <http://localhost:8000/> を開きます。

> 同期が要らなければ、手順 2・3 は飛ばして「4. 公開する」へ進めます。

### 2. Firebase を用意する（クラウド同期を使う場合）

無料プラン（Spark）で使えます。

1. [Firebase コンソール](https://console.firebase.google.com/) で「プロジェクトを追加」。Google アナリティクスはオフで構いません。
2. **ウェブアプリを登録**：プロジェクトの概要 →「</>（ウェブ）」→ アプリ名を入れて登録。Firebase Hosting の設定は不要です。表示される `firebaseConfig` の中身を控えておきます。
3. **Google ログインを有効にする**：Authentication →「始める」→ ログイン方法 → Google を有効にして保存。
4. **公開先のドメインを許可する**：Authentication → 設定 → 承認済みドメイン に、公開する場所のドメインを追加します（例：GitHub Pages なら `あなたのユーザー名.github.io`）。`localhost` は最初から入っています。
5. **Firestore を作る**：Firestore Database →「データベースの作成」→ 本番環境モード → 場所を選ぶ（例：`asia-northeast1`（東京））。
6. **ルールを設定する**：Firestore Database →「ルール」タブに `firestore.rules` の中身を貼り、`you@example.com` を自分の Google アカウントに書き換えて「公開」。

### 3. 設定ファイルを書き換える

`firebase-config.js` を開いて、2 か所を書き換えます。

```js
window.FIREBASE_CONFIG = {
  apiKey: '...',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.firebasestorage.app',
  messagingSenderId: '...',
  appId: '...',
};

window.ALLOWED_EMAILS = ['you@gmail.com'];
```

- `FIREBASE_CONFIG`：手順 2-2 で控えた値。この値は公開されても問題ありません（守りは Firestore のルールが担います）。
- `ALLOWED_EMAILS`：クラウドに保存してよいアカウント。ここに無いアカウントでもログインして使えますが、ノートはその端末だけに保存され、Firebase の容量は使いません。`[]`（空）にすると、ログインした人は誰でもクラウドに保存します（そのときはルールも `firestore.rules` のコメントにある「誰でも」版にします）。

`ALLOWED_EMAILS` と `firestore.rules` のアカウントは、必ず同じにそろえてください。

### 4. 公開する（GitHub Pages の例）

1. GitHub で新しいリポジトリを作る（Public。無料プランで Pages を使うため）。
2. 展開したファイル一式（`index.html` などがリポジトリの一番上に来るように）をアップロードしてコミット。
3. リポジトリの Settings → Pages → Build and deployment で、Source を「Deploy from a branch」、Branch を `main` / `/(root)` にして保存。
4. 数分後に `https://あなたのユーザー名.github.io/リポジトリ名/` で開けます。このドメインを手順 2-4 で承認済みドメインに入れておきます。

ほかの静的ホスティング（Netlify、Cloudflare Pages、Firebase Hosting など）でも、ファイルを置くだけで動きます。HTTPS で公開してください（Service Worker とログインに必要です）。

### 5. 使い始める

公開したページを開き、「Google でログイン」で入ります。右上が「同期済み」になればクラウド同期が動いています。iPad では Safari の共有メニューから「ホーム画面に追加」すると、アプリのように使えます。

---

## ファイルを変更したとき

ブラウザや Service Worker が古いファイルを使い続けないよう、変更のたびに版の番号を上げます。

- `index.html` と `changelog.html` の `?v=数字` をすべて同じ数字に上げる
- `app.js` の中の `sync.js?v=数字` も同じ数字にする
- `changelog.html` の先頭に `vXX: 変更内容` を 1 行足し、「現在 vXX」を更新する

## 使用量の目安（Firebase 無料プラン）

- 保存容量 1 GB：手書きの線はごく小さく、ボード一覧の下に使用量が出ます。容量を使うのは主に取り込んだ画像・PDF です（PDF ごとに「この端末だけ」にもできます）。
- 読み込み 1 日 5 万回・書き込み 1 日 2 万回：変わった部分だけを、手を止めてから送るので、個人で使う分にはまず届きません。

## 配布用 zip を作り直す（作者向け）

```sh
python tools/make_dist.py
```

`dist/canvas-note.zip` が、自分用の設定を空の雛形に差し替えた状態で作られます。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面 |
| `app.js` | 描画・操作・保存（端末内の IndexedDB） |
| `sync.js` | Firebase とのクラウド同期（ログイン時に読み込む） |
| `ruler.js` | 定規 |
| `style.css` | 見た目 |
| `sw.js` | Service Worker（オフライン対応） |
| `firebase-config.js` | Firebase の設定と、クラウドに保存してよいアカウント |
| `firestore.rules` | Firestore のセキュリティルール（Firebase コンソールに貼る） |
| `changelog.html` | 変更履歴 |
| `tools/make_dist.py` | 配布用 zip を作る |
