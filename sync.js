/* =========================================================
   クラウド同期（Firebase）
   - 端末内（IndexedDB）が本体。ログイン中はそれを Firestore と同期する
   - ボード単位で「新しい方が勝つ」。両方で変更されていたら、負けた側を
     「（競合コピー）」として残すのでデータは消えない
   保存形式（fmt: 2）：
     users/{uid}/boards/{boardId}            { name, createdAt, updatedAt, bg, deleted, fmt: 2, revs: [各チャンクの rev] }
     users/{uid}/boards/{boardId}/chunks/{i} { data: 線の JSON を「,」でつないだもの, rev }
     線の区切りでチャンクに分け、rev は中身から作る。書き足しただけなら最後のチャンクしか
     変わらないので、変わったチャンクだけを送る・受け取る。
   旧形式（fmt なし）：{ chunks, rev } と、strokes 全体の JSON を切り分けた data（読み込みのみ対応）
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

const CHUNK = 200000;   // 1チャンクの目安（文字数）。1ドキュメント 1MB 制限より十分小さく
const PUSH_DELAY = 3000; // 手を止めてから送るまで
let user = null;
let unsub = null;
let remote = new Map(); // boardId -> メタデータ
let pushTimer = 0;
const chunkCache = new Map(); // `${boardId}/${i}` -> { rev, data }（受け取ったチャンクを覚えておく）

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

// 線1本の JSON（線は書き換えずに作り直す決まりなので、作った文字列を覚えておける）
const strokeJson = new WeakMap();
const round2 = (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
function jsonOf(st) {
  let s = strokeJson.get(st);
  if (!s) { s = JSON.stringify(st, round2); strokeJson.set(st, s); }
  return s;
}
// 文字列から短い目印（FNV-1a）。中身が同じなら同じ rev になる
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
// 線を区切りよくチャンクに分ける
function toChunks(strokes) {
  const chunks = [];
  let cur = [], len = 0;
  for (const st of strokes) {
    const s = jsonOf(st);
    if (cur.length && len + s.length > CHUNK) { chunks.push(cur.join(',')); cur = []; len = 0; }
    cur.push(s); len += s.length + 1;
  }
  if (cur.length) chunks.push(cur.join(','));
  return chunks;
}

/* ---------- アップロード（変わったチャンクだけ） ---------- */
async function push(b) {
  const updatedAt = b.updatedAt;
  const chunks = b.deleted ? [] : toChunks(App.strokesOf(b));
  const revs = chunks.map(hashStr);
  const prev = remote.get(b.id);
  const prevRevs = prev && prev.fmt === 2 ? prev.revs || [] : [];
  const prevCount = prev ? (prev.fmt === 2 ? prevRevs.length : prev.chunks || 0) : 0;

  const batch = F.writeBatch(db);
  batch.set(boardDoc(b.id), {
    name: b.name || '無題', createdAt: b.createdAt || updatedAt, updatedAt, bg: b.bg || null,
    deleted: !!b.deleted, fmt: 2, revs,
  });
  chunks.forEach((data, i) => {
    if (prevRevs[i] !== revs[i]) batch.set(F.doc(chunksCol(b.id), String(i)), { data, rev: revs[i] });
    chunkCache.set(`${b.id}/${i}`, { rev: revs[i], data });
  });
  for (let i = chunks.length; i < prevCount; i++) batch.delete(F.doc(chunksCol(b.id), String(i)));
  await withTimeout(batch.commit(), 30000);

  remote.set(b.id, { id: b.id, name: b.name, updatedAt, deleted: !!b.deleted, fmt: 2, revs });
  b.syncedAt = updatedAt;
  if (b.deleted) await App.removeLocal(b.id);  // 削除をクラウドに伝えたので端末からは消してよい
  else await App.persist(b);
}

/* ---------- ダウンロード ---------- */
async function pull(meta) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = meta.fmt === 2 ? await pullV2(meta) : await pullV1(meta);
    if (r) return r;
    // 書き込み途中だった → メタデータを取り直す
    const m = await F.getDoc(boardDoc(meta.id));
    if (!m.exists()) return null;
    meta = { id: meta.id, ...m.data() };
    remote.set(meta.id, meta);
  }
  throw new Error('ボードの読み込みに失敗しました');
}
// 新形式：覚えているチャンクと rev が同じなら取りに行かない
async function pullV2(meta) {
  const revs = meta.revs || [], parts = [];
  for (let i = 0; i < revs.length; i++) {
    const key = `${meta.id}/${i}`, c = chunkCache.get(key);
    if (c && c.rev === revs[i]) { parts.push(c.data); continue; }
    const d = await F.getDoc(F.doc(chunksCol(meta.id), String(i)));
    if (!d.exists() || d.data().rev !== revs[i]) return null;
    chunkCache.set(key, { rev: revs[i], data: d.data().data });
    parts.push(d.data().data);
  }
  return JSON.parse('[' + parts.filter(Boolean).join(',') + ']');
}
// 旧形式
async function pullV1(meta) {
  const snap = await F.getDocs(chunksCol(meta.id));
  const docs = snap.docs.map(d => ({ i: +d.id, ...d.data() }))
    .filter(d => d.i < meta.chunks).sort((a, b) => a.i - b.i);
  if (docs.length !== meta.chunks || !docs.every(d => d.rev === meta.rev)) return null;
  return meta.chunks ? JSON.parse(docs.map(d => d.data).join('')) : [];
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
    pushTimer = setTimeout(() => enqueue(reconcile), PUSH_DELAY);
  },
};
App.syncReady();
