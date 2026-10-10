/* =========================================================
   クラウド同期（Firebase）
   - 端末内（IndexedDB）が本体。ログイン中はそれを Firestore と同期する
   - ボード単位で「新しい方が勝つ」。両方で変更されていたら、負けた側を
     「（競合コピー）」として残すのでデータは消えない
   保存形式（fmt: 3）：
     users/{uid}                              { boards: { [boardId]: { name, createdAt, updatedAt, bg, deleted, revs } } }
       … ボードの一覧（目録）を1つのドキュメントにまとめる。開いたときの読み込みは1回で済む
     users/{uid}/boards/{boardId}/chunks/{i}  { data: 線の JSON を「,」でつないだもの, rev }
       … 線をいくつかずつまとめたチャンク。rev は中身から作るので、中身が同じなら同じ rev
   使用量を抑える工夫：
     ・チャンクの区切りは線の id で決める → 線を書き足したり消したりしても、変わるのはその付近だけ
     ・変わったチャンクだけ送る。受け取るときも、端末にある線から同じ rev のチャンクを作れるなら取りに行かない
     ・送るのは手を止めて PUSH_IDLE 後（書き続けていても PUSH_MAX ごと）。画面を離れるときはすぐ送る
   旧形式：users/{uid}/boards/{boardId} に一覧を1つずつ置く形（fmt 2 / fmt なし）。目録が無いときに1回だけ読んで移す
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

const CHUNK_MAX = 400000;  // 1チャンクの上限（文字数）。1ドキュメント 1MB 制限より十分小さく
const CUT_EVERY = 256;     // 平均してこの本数ごとにチャンクを区切る（線の id で決める）
const PUSH_IDLE = 10000;   // 手を止めてから送るまで
const PUSH_MAX = 60000;    // 書き続けていても、これ以上は待たない
let user = null;
let unsub = null;
let remote = new Map();    // boardId -> 目録の内容
let pushTimer = 0, firstDirtyAt = 0;
let ready = false;          // クラウドの目録を一度受け取ったか（受け取るまでは送らない＝上書き事故を防ぐ）
let retryTimer = 0, retryDelay = 0;
const chunkCache = new Map(); // `${boardId}/${i}` -> { rev, data }

/* ---------- 処理を1つずつ順番に実行する。失敗したら間を空けてやり直す ---------- */
let queue = Promise.resolve();
const enqueue = fn => (queue = queue.then(fn).then(() => { retryDelay = 0; }).catch(err => {
  console.error(err);
  App.setSyncStatus(navigator.onLine ? 'error' : 'offline', err.message);
  if (!user) return;
  // 5秒 → 10秒 → 20秒 … 最長1分ごとにやり直す（オフラインの間は、つながったときに）
  retryDelay = Math.min(60000, retryDelay ? retryDelay * 2 : 5000);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (!navigator.onLine) return;
    if (ready) { enqueue(reconcile); return; }
    if (unsub) { unsub(); unsub = null; } // 最初の受け取りで失敗していた → 見張り直す
    startListening();
  }, retryDelay);
}));

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('タイムアウトしました')), ms))]);
const userDoc = () => F.doc(db, 'users', user.uid);
const boardsCol = () => F.collection(db, 'users', user.uid, 'boards');
const boardDoc = id => F.doc(db, 'users', user.uid, 'boards', id);
const chunksCol = id => F.collection(db, 'users', user.uid, 'boards', id, 'chunks');
const isDirty = b => b.updatedAt !== b.syncedAt;
// 自動で作った空のボード（一度も触っていない）は同期しない。クラウドにボードがあれば片付ける。
// 自分で作ったボードは、空でも同期する（消さない）
const isPristine = b => b.auto && !b.syncedAt && !b.deleted && !App.strokesOf(b).length && b.createdAt === b.updatedAt;

/* ---------- チャンク ---------- */
// 線1本の JSON（線は書き換えずに作り直す決まりなので、作った文字列を覚えておける）
const strokeJson = new WeakMap();
const round2 = (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
function jsonOf(st) {
  let s = strokeJson.get(st);
  if (!s) { s = JSON.stringify(st, round2); strokeJson.set(st, s); }
  return s;
}
// 文字列から短い目印（FNV-1a）。中身が同じなら同じ値
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
// 線の id から決まる区切り（どこかで線を足し引きしても、ほかの区切りは動かない）
const cutAfter = st => { let h = 0; for (const ch of String(st.id)) h = (h * 31 + ch.charCodeAt(0)) | 0; return (h >>> 0) % CUT_EVERY === 0; };
function toChunks(strokes) {
  const chunks = [];
  let cur = [], len = 0;
  for (const st of strokes) {
    const s = jsonOf(st);
    if (cur.length && len + s.length > CHUNK_MAX) { chunks.push(cur.join(',')); cur = []; len = 0; }
    cur.push(s); len += s.length + 1;
    if (cutAfter(st)) { chunks.push(cur.join(',')); cur = []; len = 0; }
  }
  if (cur.length) chunks.push(cur.join(','));
  return chunks;
}
// 端末にある線から作れるチャンク（rev -> 中身）。受け取るときに、同じものは取りに行かない
function localChunks(b) {
  const m = new Map();
  if (b) for (const data of toChunks(App.strokesOf(b))) m.set(hashStr(data), data);
  return m;
}

/* ---------- 画像（取り込んだ画像・PDF のページ） ----------
     users/{uid}/assets/{id}          { mime, w, h, n: 分けた数 }
     users/{uid}/assets/{id}/p/{i}    { d: base64 の一部 }
   画像は作り直さないので、一度送れば終わり。受け取りも、表示に必要になったときに1回だけ */
const ASSET_PART = 900000; // 1ドキュメント 1MB 制限より小さく（文字数）
const assetDoc = id => F.doc(db, 'users', user.uid, 'assets', id);
const assetPart = (id, i) => F.doc(db, 'users', user.uid, 'assets', id, 'p', String(i));
async function uploadAssets(b) {
  const ids = [...new Set(App.strokesOf(b).filter(s => s.t === 'img').map(s => s.a))];
  for (const id of ids) {
    const rec = await App.getAsset(id);
    if (!rec || rec.up) continue; // この端末にない（＝別の端末から来た、もう送ってある）か、送り済み
    const b64 = await App.blobToBase64(rec.blob), n = Math.max(1, Math.ceil(b64.length / ASSET_PART));
    const batch = F.writeBatch(db);
    for (let i = 0; i < n; i++) batch.set(assetPart(id, i), { d: b64.slice(i * ASSET_PART, (i + 1) * ASSET_PART) });
    batch.set(assetDoc(id), { mime: rec.mime, w: rec.w, h: rec.h, n }); // 部品を全部置いてから目印（同じ書き込みの中）
    await withTimeout(batch.commit(), 60000);
    await App.putAsset({ ...rec, up: true });
  }
}
// 別の端末で取り込んだ画像を受け取る（同じ画像を同時に頼まれても1回だけ）
const fetching = new Map();
function fetchAsset(id) {
  if (!user || !ready) return Promise.reject(new Error('同期の準備ができていません'));
  if (fetching.has(id)) return fetching.get(id);
  const p = (async () => {
    const m = await F.getDoc(assetDoc(id));
    if (!m.exists()) return null; // まだ届いていない（送った側の同期待ち）
    const { mime, w, h, n } = m.data(), parts = [];
    for (let i = 0; i < n; i++) {
      const d = await F.getDoc(assetPart(id, i));
      if (!d.exists()) return null;
      parts.push(d.data().d);
    }
    const rec = { id, mime, w, h, blob: App.base64ToBlob(parts.join(''), mime), up: true };
    await App.putAsset(rec);
    return rec;
  })().finally(() => fetching.delete(id));
  fetching.set(id, p);
  return p;
}

/* ---------- アップロード（変わったチャンクだけ） ---------- */
async function push(b) {
  if (!b.deleted) await uploadAssets(b); // 画像を先に（ほかの端末で線より先に画像が無いと困るので）
  const updatedAt = b.updatedAt;
  const chunks = b.deleted ? [] : toChunks(App.strokesOf(b));
  const revs = chunks.map(hashStr);
  const prev = remote.get(b.id);
  const prevRevs = prev && prev.fmt === 3 ? prev.revs || [] : [];
  const prevCount = prev ? (prev.revs ? prev.revs.length : prev.chunks || 0) : 0;

  const meta = {
    name: b.name || '無題', createdAt: b.createdAt || updatedAt, updatedAt, bg: b.bg || null,
    deleted: !!b.deleted, folder: b.folder || null, revs,
  };
  const batch = F.writeBatch(db);
  batch.set(userDoc(), { boards: { [b.id]: meta } }, { merge: true });
  chunks.forEach((data, i) => {
    if (prevRevs[i] !== revs[i]) batch.set(F.doc(chunksCol(b.id), String(i)), { data, rev: revs[i] });
    chunkCache.set(`${b.id}/${i}`, { rev: revs[i], data });
  });
  for (let i = chunks.length; i < prevCount; i++) batch.delete(F.doc(chunksCol(b.id), String(i)));
  if (prev && prev.legacy) batch.delete(boardDoc(b.id)); // 旧形式の一覧を片付ける
  await withTimeout(batch.commit(), 30000);

  remote.set(b.id, { id: b.id, ...meta, fmt: 3 });
  b.syncedAt = updatedAt;
  if (b.deleted) await App.removeLocal(b.id);  // 削除をクラウドに伝えたので端末からは消してよい
  else await App.persist(b);
}

/* ---------- ダウンロード ---------- */
async function pull(meta) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = meta.revs ? await pullChunks(meta) : await pullV1(meta);
    if (r) return r;
    // 書き込み途中だった → 目録を取り直す
    await refreshMeta(meta.id);
    meta = remote.get(meta.id);
    if (!meta) return null;
  }
  throw new Error('ボードの読み込みに失敗しました');
}
// rev が同じチャンクは、覚えているもの・端末の線から作れるものを使い、無いものだけ取りに行く
async function pullChunks(meta) {
  const revs = meta.revs || [], parts = [];
  let local = null;
  for (let i = 0; i < revs.length; i++) {
    const key = `${meta.id}/${i}`, c = chunkCache.get(key);
    if (c && c.rev === revs[i]) { parts.push(c.data); continue; }
    if (!local) local = localChunks(App.boards().find(b => b.id === meta.id));
    if (local.has(revs[i])) { const data = local.get(revs[i]); chunkCache.set(key, { rev: revs[i], data }); parts.push(data); continue; }
    const d = await F.getDoc(F.doc(chunksCol(meta.id), String(i)));
    if (!d.exists() || d.data().rev !== revs[i]) return null;
    chunkCache.set(key, { rev: revs[i], data: d.data().data });
    parts.push(d.data().data);
  }
  return JSON.parse('[' + parts.filter(Boolean).join(',') + ']');
}
// いちばん古い形式（strokes 全体の JSON を切り分けたもの）
async function pullV1(meta) {
  const snap = await F.getDocs(chunksCol(meta.id));
  const docs = snap.docs.map(d => ({ i: +d.id, ...d.data() }))
    .filter(d => d.i < meta.chunks).sort((a, b) => a.i - b.i);
  if (docs.length !== meta.chunks || !docs.every(d => d.rev === meta.rev)) return null;
  return meta.chunks ? JSON.parse(docs.map(d => d.data).join('')) : [];
}
async function refreshMeta(id) {
  const u = await F.getDoc(userDoc());
  const m = u.exists() && u.data().boards && u.data().boards[id];
  if (m) { remote.set(id, { id, ...m, fmt: 3 }); return; }
  const o = await F.getDoc(boardDoc(id)); // 旧形式
  if (o.exists()) remote.set(id, { id, ...o.data(), legacy: true });
  else remote.delete(id);
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
    syncedAt: meta.updatedAt, bg: meta.bg || { type: 'grid', size: 32 }, folder: meta.folder || null, strokes,
  }, force);
}
async function remoteAsBoard(meta) {
  const strokes = await pull(meta) || [];
  return { id: meta.id, name: meta.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt, bg: meta.bg, folder: meta.folder || null, strokes };
}

/* ---------- 突き合わせ ---------- */
async function reconcile() {
  if (!user) return;
  if (!navigator.onLine) { App.setSyncStatus('offline'); return; }
  // クラウドの目録をまだ受け取っていない（オフラインで開いた直後など）→ 受け取ったときに改めて
  if (!ready) { App.setSyncStatus(firstDirtyAt ? 'pending' : 'syncing'); return; }
  App.setSyncStatus('syncing');
  const dirtyAt = firstDirtyAt;
  firstDirtyAt = 0;
  try { await reconcileInner(); }
  catch (e) { if (!firstDirtyAt) firstDirtyAt = dirtyAt || Date.now(); throw e; } // 送れなかった印を残す
}
async function reconcileInner() {
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
  // 旧形式のボードを新しい形式（目録）に移す（1回だけ）
  for (const meta of [...remote.values()]) {
    if (!meta.legacy || meta.deleted) continue;
    const b = App.boards().find(x => x.id === meta.id);
    if (b && !b.deleted) await push(b);
  }
  App.setSyncStatus(firstDirtyAt ? 'pending' : 'ok');
}

/* ---------- 目録を見張る（ドキュメント1つだけ） ----------
   オフラインで始めても、つながれば Firebase が自動で受け取り、そこから同期が始まる */
function startListening() {
  ready = false;
  // includeMetadataChanges：オフラインで始めて「まだ目録が無い」まま、つながったことも知るため
  unsub = F.onSnapshot(userDoc(), { includeMetadataChanges: true }, snap => {
    if (snap.metadata && (snap.metadata.hasPendingWrites || snap.metadata.fromCache)) return; // 自分の書き込み・確かでない内容
    const boards = (snap.exists() && snap.data().boards) || null;
    const first = !ready;
    enqueue(async () => {
      // 目録がまだ無い（旧形式だけ）なら、旧形式の一覧を1回だけ読む
      if (first && !boards) {
        const s = await F.getDocs(boardsCol());
        for (const d of s.docs) remote.set(d.id, { id: d.id, ...d.data(), legacy: true });
      }
      for (const [id, m] of Object.entries(boards || {})) remote.set(id, { id, ...m, fmt: 3 });
      ready = true;
      await reconcile();
    });
  }, err => {
    App.setSyncStatus('error', err.message);
    // 見張りが止まった → 少し待ってやり直す
    if (unsub) { unsub(); unsub = null; }
    setTimeout(() => { if (user && !unsub) startListening(); }, 10000);
  });
}

A.onAuthStateChanged(auth, u => {
  user = u;
  if (unsub) { unsub(); unsub = null; }
  remote = new Map();
  ready = false;
  App.setSyncUser(u ? (u.email || u.displayName || 'ログイン中') : null);
  if (u) { App.setSyncStatus(navigator.onLine ? 'syncing' : 'offline'); startListening(); }
  else App.setSyncStatus('signedout');
});
A.getRedirectResult(auth).catch(err => App.setSyncStatus('error', err.message));

const pushSoon = () => { clearTimeout(pushTimer); enqueue(reconcile); };
window.addEventListener('online', () => { retryDelay = 0; pushSoon(); });
window.addEventListener('offline', () => user && App.setSyncStatus('offline'));
// 画面を離れるときは待たずに送る
document.addEventListener('visibilitychange', () => {
  if (!user) return;
  if (document.hidden) { if (firstDirtyAt) pushSoon(); }
  else if (firstDirtyAt && navigator.onLine) pushSoon(); // 戻ってきたとき、送れていないものがあれば
});
window.addEventListener('pagehide', () => { if (user && firstDirtyAt) pushSoon(); });

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
  syncNow: pushSoon,
  fetchAsset,
  // ローカルで変更があったら呼ばれる。手を止めて PUSH_IDLE 後に送る（最長 PUSH_MAX）
  changed() {
    if (!user) return;
    const now = Date.now();
    if (!firstDirtyAt) firstDirtyAt = now;
    App.setSyncStatus('pending');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => enqueue(reconcile), Math.max(0, Math.min(PUSH_IDLE, firstDirtyAt + PUSH_MAX - now)));
  },
};
App.syncReady();
