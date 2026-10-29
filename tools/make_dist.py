"""配布用の zip（dist/canvas-note.zip）を作る。

自分用の設定（Firebase のプロジェクト・許可するアカウント）を空の雛形に差し替えて固める。
使い方：python tools/make_dist.py
"""
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'dist' / 'canvas-note.zip'

# そのまま入れるファイル
FILES = [
    'index.html', 'changelog.html', 'page-template.html', 'app.js', 'sync.js', 'ruler.js', 'style.css',
    'sw.js', 'manifest.webmanifest', 'icon.svg', 'README.md',
]

CONFIG = """// Firebase の設定。null のままだとクラウド同期はオフ（ログイン画面も出ず、端末内だけに保存）。
// 使うときは Firebase コンソールの「プロジェクトの設定 → マイアプリ」にある firebaseConfig を貼る。
// ここに書く値は公開されても問題ない（アクセス制限は Firestore のルールで行う）。
window.FIREBASE_CONFIG = null;
/* 例：
window.FIREBASE_CONFIG = {
  apiKey: '...',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.firebasestorage.app',
  messagingSenderId: '...',
  appId: '...',
};
*/

// クラウドに保存してよいアカウント（Google のメールアドレス）。ほかのアカウントはこの端末だけに保存する。
// 空 [] にすると、ログインした人は誰でもクラウドに保存する。firestore.rules と同じアカウントにそろえる。
window.ALLOWED_EMAILS = [];
"""

RULES = """rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 許可したアカウントが、自分のデータだけ読み書きできる
    // you@example.com を自分の Google アカウントに書き換える（firebase-config.js の ALLOWED_EMAILS と合わせる）
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid
        && request.auth.token.email_verified == true
        && request.auth.token.email in ['you@example.com'];
    }
    // 誰でも使ってよい（ALLOWED_EMAILS を空にした）ときは、上の3行の代わりにこちら
    // allow read, write: if request.auth != null && request.auth.uid == uid;
  }
}
"""


def main():
    OUT.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in FILES:
            z.write(ROOT / f, f'canvas-note/{f}')
        z.writestr('canvas-note/firebase-config.js', CONFIG)
        z.writestr('canvas-note/firestore.rules', RULES)
    print(f'作成しました: {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
