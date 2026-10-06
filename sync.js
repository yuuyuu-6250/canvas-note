/* =========================================================
   クラウド同期（Firebase）
   - 端末内（IndexedDB）が本体。ログイン中はそれを Firestore と同期する
   - ボード単位で「新しい方が勝つ」。両方で変更されていたら、負けた側を
     「（競合コピー）」として残すのでデータは消えない
   保存形式：
     users/{uid}/boards/{boardId}            { name, createdAt, updatedAt, bg, deleted, chunks, rev }
     users/{uid}/boards/{boardId}/chunks/{i} { data: strokes の JSON の一部, rev }
   ========================================================= */
const V = '12.19.0';
const [{ initializeApp }, A, F] = await Promise.all([
  import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
  import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
  import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
]);

const App = window.App;
const fb = initializeApp(window.FIREBASE_CONFIG);
const auth = A.getAuth(fb);
const db = F.getFirestore(fb);

const CHUNK = 800000;   // 1ドキュメント 1MB 制限より小さく
let user = null;
let unsub = null;
let remote = new Map(); // boardId -> メタデータ
let pushTimer = 0;

/* ---------- 処理を1つずつ順番に実行する ---------- */
let queue = Promise.resolve();
const enqueue = fn => (queue = queue.then(fn).catch(err => {
  console.error(err);
  App.setSyncStatus(navigator.onLine ? 'error' : 'offline', err.message);
}));

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('タイムアウトしました')), ms))]);
const boardsCol = () => F.collection(db, 'users', user.uid, 'boards');
const boardDoc = id => F.doc(db, 'users', user.uid, 'boards', id);
const chunksCol = id => F.collection(db, 'users', user.uid, 'boards', id, 'chunks');
const isDirty = b => b.updatedAt !== b.syncedAt;
// 新規の空ボード（何も描いていない）は同期しない
const isPristine = b => !b.syncedAt && !b.deleted && !App.strokesOf(b).length && b.createdAt === b.updatedAt;

const serialize = strokes => JSON.stringify(strokes, (k, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v);

/* ---------- アップロード ---------- */
async function push(b) {
  const updatedAt = b.updatedAt;
  const rev = Math.random().toString(36).slice(2);
  const json = b.deleted ? '' : serialize(App.strokesOf(b));
  const parts = [];
  for (let i = 0; i < json.length; i += CHUNK) parts.push(json.slice(i, i + CHUNK));
  const prevChunks = remote.get(b.id)?.chunks || 0;

  const batch = F.writeBatch(db);
  batch.set(boardDoc(b.id), {
    name: b.name || '無題', createdAt: b.createdAt || updatedAt, updatedAt, bg: b.bg || null,
    deleted: !!b.deleted, chunks: parts.length, rev,
  });
  parts.forEach((data, i) => batch.set(F.doc(chunksCol(b.id), String(i)), { data, rev }));
  for (let i = parts.length; i < prevChunks; i++) batch.delete(F.doc(chunksCol(b.id), String(i)));
  await withTimeout(batch.commit(), 30000);

  remote.set(b.id, { id: b.id, name: b.name, updatedAt, deleted: !!b.deleted, chunks: parts.length, rev });
  b.syncedAt = updatedAt;
  if (b.deleted) await App.removeLocal(b.id);  // 削除をクラウドに伝えたので端末からは消してよい
  else await App.persist(b);
}

/* ---------- ダウンロード ---------- */
async function pull(meta) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snap = await F.getDocs(chunksCol(meta.id));
    const docs = snap.docs.map(d => ({ i: +d.id, ...d.data() }))
      .filter(d => d.i < meta.chunks).sort((a, b) => a.i - b.i);
    if (docs.length === meta.chunks && docs.every(d => d.rev === meta.rev)) {
      const strokes = meta.chunks ? JSON.parse(docs.map(d => d.data).join('')) : [];
      return strokes;
    }
    // 書き込み途中だった → メタデータを取り直す
    const m = await F.getDoc(boardDoc(meta.id));
    if (!m.exists()) return null;
    meta = { id: meta.id, ...m.data() };
    remote.set(meta.id, meta);
  }
  throw new Error('ボードの読み込みに失敗しました');
}

async function applyRemote(meta, local, force = false) {
  if (meta.deleted) {
    if (local) await App.removeLocal(local.id);
    return;
  }
  const strokes = await pull(meta);
  if (!strokes) return;
  await App.applyRemote({
    id: meta.id, name: meta.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
    syncedAt: meta.updatedAt, bg: meta.bg || { type: 'grid', size: 32 }, strokes,
  }, force);
}

/* ---------- 突き合わせ ---------- */
async function reconcile() {
  if (!user) return;
  if (!navigator.onLine) { App.setSyncStatus('offline'); return; }
  App.setSyncStatus('syncing');
  App.saveNow();
  const locals = new Map(App.boards().map(b => [b.id, b]));

  for (const meta of remote.values()) {
    const local = locals.get(meta.id);
    if (!local) { if (!meta.deleted) await applyRemote(meta, null); continue; }
    const remoteChanged = meta.updatedAt !== local.syncedAt;
    if (!remoteChanged) continue;
    if (isDirty(local) && !local.deleted && !meta.deleted) {
      // 両方で変更あり：新しい方を採用し、古い方はコピーとして残す
      if (local.updatedAt > meta.updatedAt) {
        await App.duplicateAsConflict(await remoteAsBoard(meta));
        local.syncedAt = meta.updatedAt; // 次の push で上書き
      } else {
        await App.duplicateAsConflict(local);
        await applyRemote(meta, local, true);
      }
    } else if (meta.deleted && isDirty(local)) {
      // 他の端末で削除されたが、こちらで編集していた → こちらを残す
      local.syncedAt = meta.updatedAt;
    } else if (isDirty(local) && local.deleted) {
      // こちらで削除済み → 削除を送る（下のループで）
      local.syncedAt = meta.updatedAt;
    } else {
      await applyRemote(meta, local);
    }
  }

  // クラウドにボードがあるなら、この端末の空の初期ボードは片付ける
  const remoteHasBoards = [...remote.values()].some(m => !m.deleted);
  for (const b of App.boards()) {
    if (isPristine(b)) { if (remoteHasBoards) await App.removeLocal(b.id); continue; }
    if (isDirty(b)) await push(b);
  }
  App.setSyncStatus('ok');
}

/* ---------- ログイン状態 ---------- */
function startListening() {
  unsub = F.onSnapshot(boardsCol(), snap => {
    for (const ch of snap.docChanges()) {
      if (ch.doc.metadata.hasPendingWrites) continue;
      if (ch.type === 'removed') remote.delete(ch.doc.id);
      else remote.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
    }
    enqueue(reconcile);
  }, err => App.setSyncStatus('error', err.message));
}

async function remoteAsBoard(meta) {
  const strokes = await pull(meta) || [];
  return { id: meta.id, name: meta.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt, bg: meta.bg, strokes };
}

A.onAuthStateChanged(auth, u => {
  user = u;
  if (unsub) { unsub(); unsub = null; }
  remote = new Map();
  App.setSyncUser(u ? (u.email || u.displayName || 'ログイン中') : null);
  if (u) { App.setSyncStatus('syncing'); startListening(); }
  else App.setSyncStatus('signedout');
});
A.getRedirectResult(auth).catch(err => App.setSyncStatus('error', err.message));

window.addEventListener('online', () => enqueue(reconcile));
window.addEventListener('offline', () => user && App.setSyncStatus('offline'));
document.addEventListener('visibilitychange', () => {
  if (!user) return;
  if (document.hidden) { clearTimeout(pushTimer); enqueue(reconcile); }
  else enqueue(reconcile);
});

window.Sync = {
  async signIn() {
    const provider = new A.GoogleAuthProvider();
    try { await A.signInWithPopup(auth, provider); }
    catch (err) {
      if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
        await A.signInWithRedirect(auth, provider);
      } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') throw err;
    }
  },
  signOut: () => A.signOut(auth),
  syncNow: () => enqueue(reconcile),
  // ローカルで変更があったら呼ばれる
  changed() {
    if (!user) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => enqueue(reconcile), 2000);
  },
};
App.syncReady();
