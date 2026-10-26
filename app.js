'use strict';

/* =========================================================
   保存（IndexedDB）
   クラウド同期を入れるときは、この Store を差し替える。
   ========================================================= */
// boards  ：ボード全体（線をすべて含む）
// pending ：まだボード全体に書き込んでいない「書き足した線」。1本ずつ小さく追記するので速い。
//           手を止めたときにボード全体を書き直し、ここは空にする（compact）
const Store = (() => {
  let dbp = null, db = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('canvas-note', 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('boards')) d.createObjectStore('boards', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('pending')) d.createObjectStore('pending', { keyPath: ['b', 'id'] });
      // assets：取り込んだ画像（PDF はページごとの画像）{ id, blob, mime, w, h, up: クラウドに送ったか }
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' });
    };
    r.onsuccess = () => res(db = r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = (d, stores, mode, fn) => new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
  // 開いていればその場で書き込みを始める（ページを閉じる直前でも間に合うように、await を挟まない）
  const run = (stores, mode, fn) => (db ? tx(db, stores, mode, fn) : open().then(d => tx(d, stores, mode, fn)));
  const boardRange = id => IDBKeyRange.bound([id], [id, []]);
  return {
    all: () => run('boards', 'readonly', t => t.objectStore('boards').getAll()),
    // ボード全体を書き、そのボードの pending を消す（同じトランザクションなので途中で止まっても失われない）
    put: b => run(['boards', 'pending'], 'readwrite', t => {
      t.objectStore('pending').delete(boardRange(b.id));
      return t.objectStore('boards').put(b);
    }),
    del: id => run(['boards', 'pending'], 'readwrite', t => {
      t.objectStore('pending').delete(boardRange(id));
      return t.objectStore('boards').delete(id);
    }),
    addPending: (boardId, st) => run('pending', 'readwrite', t => t.objectStore('pending').put({ b: boardId, id: st.id, st })),
    allPending: () => run('pending', 'readonly', t => t.objectStore('pending').getAll()),
    getAsset: id => run('assets', 'readonly', t => t.objectStore('assets').get(id)),
    putAsset: rec => run('assets', 'readwrite', t => t.objectStore('assets').put(rec)),
  };
})();

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* =========================================================
   設定値
   ========================================================= */
const PEN_COLORS = ['#1f2328', '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed'];
const HL_COLORS = ['#fde047', '#86efac', '#f9a8d4', '#93c5fd', '#fdba74'];
const PEN_WIDTHS = [1.5, 3, 5, 9];
const HL_WIDTHS = [12, 20, 32];
const ERASER_SIZES = [8, 16, 32];
// キャンバスに描く色（テーマごと）
const THEMES = {
  light: {
    paper: '#ffffff', bgInk: '#64748b', bgK: 1, hlAlpha: 0.42,
    accent: '#2563eb', accentSoft: 'rgba(37,99,235,.06)', eraserFill: 'rgba(255,255,255,.5)', eraserLine: 'rgba(0,0,0,.45)',
    rulerFill: 'rgba(148,163,184,.22)', rulerLine: 'rgba(51,65,85,.55)', rulerText: 'rgba(51,65,85,.8)', axis: 'rgba(51,65,85,.5)',
    knobFill: 'rgba(255,255,255,.95)', knobLine: 'rgba(51,65,85,.5)', knobIcon: '#334155',
    curve: 'rgba(37,99,235,.8)', curveBand: 'rgba(37,99,235,.07)', pillBg: 'rgba(31,35,40,.85)', pillText: '#ffffff',
  },
  dark: {
    paper: '#1b1c20', bgInk: '#cbd5e1', bgK: 0.55, hlAlpha: 0.5,
    accent: '#60a5fa', accentSoft: 'rgba(96,165,250,.08)', eraserFill: 'rgba(255,255,255,.1)', eraserLine: 'rgba(255,255,255,.55)',
    rulerFill: 'rgba(148,163,184,.14)', rulerLine: 'rgba(203,213,225,.5)', rulerText: 'rgba(203,213,225,.85)', axis: 'rgba(203,213,225,.45)',
    knobFill: 'rgba(44,46,53,.95)', knobLine: 'rgba(203,213,225,.4)', knobIcon: '#cbd5e1',
    curve: 'rgba(96,165,250,.9)', curveBand: 'rgba(96,165,250,.1)', pillBg: 'rgba(235,237,242,.92)', pillText: '#1f2328',
  },
};
let T = THEMES.light;
const BG_STRENGTH = 0.25; // 背景の線の濃さ（0〜1）の初期値

// 2色を a : (1 - a) で混ぜる（#rrggbb どうし）
const mixCache = new Map();
function mixColor(c1, c2, a) {
  const key = c1 + c2 + a.toFixed(3);
  let v = mixCache.get(key);
  if (!v) {
    const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)), A = p(c1), B = p(c2);
    v = '#' + A.map((x, i) => Math.round(x + (B[i] - x) * a).toString(16).padStart(2, '0')).join('');
    mixCache.set(key, v);
  }
  return v;
}

// ダークでは、保存した色はそのままに、暗い色（黒など）を明るくして表示する
const inkCache = new Map();
function inkColor(c, th = T) {
  if (th !== THEMES.dark) return c;
  let v = inkCache.get(c);
  if (v) return v;
  v = c;
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) {
    const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (l < 0.62) {
      // 明るさだけ変える（色相・彩度は保つ）：黒は白っぽく、中くらいの色は少し明るく
      const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
      let h = 0;
      if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      if (h < 0) h += 6;
      const L = Math.max(l < 0.5 ? 1 - l : l, 0.62), C =(1 - Math.abs(2 * L - 1)) * s, X = C * (1 - Math.abs((h % 2 + 2) % 2 - 1)), M = L - C / 2;
      const [r1, g1, b1] = h < 1 ? [C, X, 0] : h < 2 ? [X, C, 0] : h < 3 ? [0, C, X] : h < 4 ? [0, X, C] : h < 5 ? [X, 0, C] : [C, 0, X];
      v = '#' + [r1, g1, b1].map(x => Math.round((x + M) * 255).toString(16).padStart(2, '0')).join('');
    }
  }
  inkCache.set(c, v);
  return v;
}
const RULER_W = 84;       // 定規の幅（画面px）
const RULER_KNOB = 150;   // 回転つまみの位置（中心からの距離）
const RULER_SNAP = 48;    // 定規の縁に吸着する距離

/* =========================================================
   状態
   ========================================================= */
const S = {
  boards: [],
  board: null,
  strokes: [],
  view: { x: 0, y: 0, s: 1 },
  tool: 'pen',
  pen: LS.get('pen', { color: PEN_COLORS[0], width: 3 }),
  hl: LS.get('hl', { color: HL_COLORS[0], width: 20 }),
  eraser: LS.get('eraser', { mode: 'object', size: 16 }),
  // 定規はキャンバス（ワールド座標）に固定。wx,wy = 原点、unit = 関数定規の1目盛（ワールド単位）
  ruler: { on: false, wx: 0, wy: 0, a: 0, ...LS.get('ruler2', { type: 'line', expr: 'x^2', unit: 32 }) },
  sel: null,          // { set:Set<stroke>, bb, dx, dy }
  cur: null,          // 描画中のストローク
  lasso: null,        // 投げ縄の点（ワールド座標）
  undo: [], redo: [],
  penSeen: false,
  finger: LS.get('finger', 'auto'),
  theme: LS.get('theme', 'auto'),   // auto | light | dark
  smooth: LS.get('smooth', 50),     // 手ぶれ補正の強さ（0〜100）
  penMin: LS.get('penMin', 0.02),   // ペンが触れたとみなす筆圧（0 なら判定しない）
};

/* ストローク = { id, t:'pen'|'hl', c:色, w:太さ, pr:筆圧あり, p:[x,y,筆圧, ...] }
   ストロークは不変オブジェクトとして扱う（変更時は新しいオブジェクトを作る） */

/* =========================================================
   キャンバス
   ========================================================= */
const main = $('#main'), over = $('#overlay');
const mc = main.getContext('2d'), oc = over.getContext('2d');
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = window.devicePixelRatio || 1;
  W = window.innerWidth; H = window.innerHeight;
  for (const c of [main, over]) {
    c.width = Math.round(W * DPR); c.height = Math.round(H * DPR);
    c.style.width = W + 'px'; c.style.height = H + 'px';
  }
  clearTiles(); // 画面の細かさ（DPR）が変わることがある
  render();
}

const toWorld = (x, y) => ({ x: (x - S.view.x) / S.view.s, y: (y - S.view.y) / S.view.s });
const toScreen = (x, y) => ({ x: x * S.view.s + S.view.x, y: y * S.view.s + S.view.y });
const viewRect = () => ({
  x0: -S.view.x / S.view.s, y0: -S.view.y / S.view.s,
  x1: (W - S.view.x) / S.view.s, y1: (H - S.view.y) / S.view.s,
});

/* ---------- ストロークの形（キャッシュ） ---------- */
const geo = new WeakMap();
const G = st => { let g = geo.get(st); if (!g) geo.set(st, g = {}); return g; };

function bbox(st) {
  const g = G(st);
  if (!g.bb) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const p = st.p;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
    }
    const r = st.w;
    g.bb = { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
  }
  return g.bb;
}

const pressureWidth = (w, pr) => w * clamp(0.35 + 1.15 * pr, 0.25, 1.6);

function buildPath(p, from, to) {
  const path = new Path2D();
  path.moveTo(p[from * 3], p[from * 3 + 1]);
  if (to === from) { path.lineTo(p[from * 3] + 0.01, p[from * 3 + 1]); return path; }
  for (let i = from + 1; i < to; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], nx = p[i * 3 + 3], ny = p[i * 3 + 4];
    path.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  path.lineTo(p[to * 3], p[to * 3 + 1]);
  return path;
}

// 太さが一定の線（筆圧なし・マーカー・点）
function runs(st) {
  const g = G(st);
  if (g.runs) return g.runs;
  const n = st.p.length / 3;
  const w = st.pr ? pressureWidth(st.w, st.p[2]) : st.w; // 筆圧ありの1点だけの線
  return g.runs = [{ w, path: buildPath(st.p, 0, n - 1) }];
}

// 筆圧のある線：各点の太さを前後となじませ、線の両側の輪郭を1つの形として塗る
// （太さが段差なく連続して変わる）。両端と鋭く曲がる所には丸を足す
function pressureShape(st) {
  const g = G(st);
  if (g.shape) return g.shape;
  // 同じ位置の点を除く
  const src = st.p, xs = [], ys = [], ps = [];
  for (let i = 0; i < src.length; i += 3) {
    const k = xs.length - 1;
    if (k >= 0 && Math.hypot(src[i] - xs[k], src[i + 1] - ys[k]) < 1e-6) continue;
    xs.push(src[i]); ys.push(src[i + 1]); ps.push(src[i + 2]);
  }
  const n = xs.length;
  let r = ps.map(pr => pressureWidth(st.w, pr) / 2);
  for (let pass = 0; pass < 4; pass++) { // 筆圧のゆらぎをならす
    const q = r.slice();
    for (let i = 1; i < n - 1; i++) q[i] = (r[i - 1] + 2 * r[i] + r[i + 1]) / 4;
    r = q;
  }
  const body = new Path2D(), caps = new Path2D();
  const circle = (i) => { caps.moveTo(xs[i] + r[i], ys[i]); caps.arc(xs[i], ys[i], r[i], 0, Math.PI * 2); };
  if (n < 2) { circle(0); return g.shape = { body, caps }; }
  // 鋭い角で区切る（角をまたいで輪郭を作ると、角の所がくびれるため）
  const cuts = [0];
  for (let i = 1; i < n - 1; i++) {
    const ax = xs[i] - xs[i - 1], ay = ys[i] - ys[i - 1], bx = xs[i + 1] - xs[i], by = ys[i + 1] - ys[i];
    if ((ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)) < 0.8) cuts.push(i);
  }
  cuts.push(n - 1);
  const nx = new Float64Array(n), ny = new Float64Array(n);
  for (let c = 0; c + 1 < cuts.length; c++) {
    const s = cuts[c], e = cuts[c + 1];
    // 区間内の各点の向き（前後の点から。区間の端は片側だけ）と、その法線
    for (let i = s; i <= e; i++) {
      const a = Math.max(s, i - 1), b = Math.min(e, i + 1);
      let dx = xs[b] - xs[a], dy = ys[b] - ys[a], L = Math.hypot(dx, dy);
      if (L < 1e-9) { dx = 1; dy = 0; L = 1; }
      nx[i] = -dy / L; ny[i] = dx / L;
    }
    body.moveTo(xs[s] + nx[s] * r[s], ys[s] + ny[s] * r[s]);
    for (let i = s + 1; i <= e; i++) body.lineTo(xs[i] + nx[i] * r[i], ys[i] + ny[i] * r[i]);
    for (let i = e; i >= s; i--) body.lineTo(xs[i] - nx[i] * r[i], ys[i] - ny[i] * r[i]);
    body.closePath();
  }
  // 両端と角に丸（区間どうしのつなぎ目も覆う）
  for (const i of cuts) circle(i);
  return g.shape = { body, caps };
}

/* ---------- 画像（取り込んだ画像・PDF のページ） ----------
   線と同じ並びに { t: 'img', a: 画像の id, w: 0, p: [左上x, 左上y, 0, 右下x, 右下y, 0] } として入れる。
   2点の「線」として扱えるので、移動・複製・拡大縮小・元に戻す・同期はそのまま使える。
   画像そのもの（ファイル）は IndexedDB の assets に置き、表示用に読み込んだものは数を絞って覚えておく */
const isImg = st => st.t === 'img';
const bitmaps = new Map();      // 画像の id -> { bm, px, used } または { loading } または { missingAt }
let bitmapPixels = 0;
const BITMAP_BUDGET = 48e6;     // 表示用に覚えておく画素数の上限（多すぎると端末のメモリが足りなくなる）
// fetch：この端末に無いとき、クラウドから取ってくるか（「この端末だけ」の画像は取りに行かない）
function getBitmap(id, fetch = true) {
  const e = bitmaps.get(id);
  if (e && e.bm) { e.used = performance.now(); return e.bm; }
  if (!e || (e.missingAt && performance.now() - e.missingAt > 5000)) loadBitmap(id, fetch);
  return null;
}
const bitmapMissing = id => { const e = bitmaps.get(id); return !!(e && e.missingAt); };
function loadBitmap(id, fetch = true) {
  const old = bitmaps.get(id);
  if (old && old.bm) return Promise.resolve(old.bm);
  if (old && old.loading) return old.loading;
  const entry = {};
  bitmaps.set(id, entry);
  entry.loading = (async () => {
    let rec = await Store.getAsset(id);
    // この端末にない → クラウドから取ってくる（別の端末で取り込んだ画像）
    if (!rec && fetch && window.Sync && window.Sync.fetchAsset) rec = await window.Sync.fetchAsset(id).catch(() => null);
    if (!rec) {
      // 無かった。「この端末だけ」の画像はこの先も来ないので探し直さない（クラウドの画像は少し待ってもう一度）
      entry.loading = null; entry.missingAt = performance.now() + (fetch ? 0 : 1e12);
      clearTiles(); renderMainSoon(); // 「この端末にない画像」の表示にする
      return null;
    }
    const bm = await createImageBitmap(rec.blob);
    Object.assign(entry, { bm, px: bm.width * bm.height, used: performance.now(), loading: null });
    bitmapPixels += entry.px;
    // 覚えすぎたら、しばらく使っていないものから手放す
    if (bitmapPixels > BITMAP_BUDGET) {
      const old = [...bitmaps.entries()].filter(([, e]) => e.bm && performance.now() - e.used > 1000).sort((a, b) => a[1].used - b[1].used);
      for (const [k, e] of old) { if (bitmapPixels <= BITMAP_BUDGET) break; e.bm.close(); bitmapPixels -= e.px; bitmaps.delete(k); }
    }
    clearTiles(); renderMainSoon();
    return bm;
  })().catch(() => { entry.loading = null; entry.missingAt = performance.now(); return null; });
  return entry.loading;
}
function drawImageObj(c, st) {
  const [x0, y0, , x1, y1] = st.p, bm = getBitmap(st.a, !st.nc);
  if (bm) {
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(bm, x0, y0, x1 - x0, y1 - y0);
  } else { // 読み込み中、またはこの端末に無い画像
    const m = c.getTransform(), k = Math.hypot(m.a, m.b) || 1, w = x1 - x0, h = y1 - y0;
    c.fillStyle = 'rgba(148,163,184,.15)'; c.fillRect(x0, y0, w, h);
    c.strokeStyle = 'rgba(148,163,184,.6)'; c.lineWidth = 1.5 * DPR / k; c.strokeRect(x0, y0, w, h);
    if (bitmapMissing(st.a)) {
      const fs = Math.min(w / 12, 15 * DPR / k);
      c.fillStyle = 'rgba(100,116,139,.9)'; c.font = `${fs}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(st.nc ? 'この端末にない画像' : '画像を受け取れませんでした', x0 + w / 2, y0 + h / 2);
    }
  }
}
// 画像が投げ縄にかかっているか（四隅のどれかが中、投げ縄の点が画像の中、辺どうしが交わる）
function imgTouchesPoly(st, poly) {
  const [x0, y0, , x1, y1] = st.p, cs = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  if (cs.some(p => pointInPoly(p.x, p.y, poly))) return true;
  if (poly.some(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)) return true;
  for (let i = 0; i < 4; i++) for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) if (segsCross(cs[i], cs[(i + 1) % 4], poly[j], poly[k])) return true;
  return false;
}
// 画像と同じまとまり（同じ PDF）の全ページと、その上に書いた線（線の中心がページの上にあるもの）
function groupWithInk(img) {
  const pages = img.g ? S.strokes.filter(st => isImg(st) && st.g === img.g) : [img];
  const set = new Set(pages);
  for (const st of S.strokes) {
    if (isImg(st)) continue;
    const b = bbox(st), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    if (pages.some(pg => cx >= pg.p[0] && cx <= pg.p[3] && cy >= pg.p[1] && cy <= pg.p[4])) set.add(st);
  }
  return set;
}
// その位置にある、いちばん上の画像
function imageAt(w) {
  for (let i = S.strokes.length - 1; i >= 0; i--) {
    const st = S.strokes[i];
    if (isImg(st) && w.x >= st.p[0] && w.x <= st.p[3] && w.y >= st.p[1] && w.y <= st.p[4]) return st;
  }
  return null;
}

function drawStroke(c, st, th = T) {
  if (st.t === 'img') { drawImageObj(c, st); return; }
  const col = inkColor(st.c, th);
  if (st.pr && st.p.length >= 6) {
    const s = pressureShape(st);
    c.fillStyle = col;
    c.fill(s.body); // 輪郭と丸は別々に塗る（向きの違う形が重なって穴があかないように）
    c.fill(s.caps);
    return;
  }
  c.strokeStyle = col;
  if (st.t === 'hl') {
    c.globalAlpha = th.hlAlpha;
    if (th === THEMES.dark) c.globalCompositeOperation = 'screen'; // 暗い紙の上では光るように重ねる
  }
  for (const r of runs(st)) { c.lineWidth = r.w; c.stroke(r.path); }
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
}

/* ---------- 背景 ---------- */
function drawBg(c, r, scale, bg, th = T) {
  if (!bg || bg.type === 'none') return;
  let s = bg.size;
  while (s * scale < 8) s *= 2;
  const lw = 1 / scale;
  const x0 = Math.floor(r.x0 / s) * s, y0 = Math.floor(r.y0 / s) * s;
  // 濃さ（0〜1）から、紙の色と線の色を混ぜた色を作る（透明度だと交点が濃くなるので使わない）
  const a = (0.04 + 0.6 * (bg.strength ?? BG_STRENGTH)) * th.bgK;
  const line = mixColor(th.paper, th.bgInk, a), major = mixColor(th.paper, th.bgInk, Math.min(1, a * 1.7));
  if (bg.type === 'dots') {
    c.fillStyle = mixColor(th.paper, th.bgInk, Math.min(1, a * 2.2));
    const d = 2.2 / scale;
    for (let x = x0; x <= r.x1; x += s)
      for (let y = y0; y <= r.y1; y += s) c.fillRect(x - d / 2, y - d / 2, d, d);
    return;
  }
  c.lineWidth = lw;
  c.strokeStyle = line;
  c.beginPath();
  if (bg.type === 'grid') for (let x = x0; x <= r.x1; x += s) { c.moveTo(x, r.y0); c.lineTo(x, r.y1); }
  for (let y = y0; y <= r.y1; y += s) { c.moveTo(r.x0, y); c.lineTo(r.x1, y); }
  c.stroke();
  if (bg.type === 'grid') {
    // 4マスごとに少し濃い線
    const M = s * 4;
    const mx0 = Math.floor(r.x0 / M) * M, my0 = Math.floor(r.y0 / M) * M;
    c.strokeStyle = major;
    c.beginPath();
    for (let x = mx0; x <= r.x1; x += M) { c.moveTo(x, r.y0); c.lineTo(x, r.y1); }
    for (let y = my0; y <= r.y1; y += M) { c.moveTo(r.x0, y); c.lineTo(r.x1, y); }
    c.stroke();
  }
}

/* ---------- 描画 ---------- */
let rafMain = 0, rafOver = 0;
function render() { renderMainSoon(); renderOverSoon(); }
function renderMainSoon() { if (!rafMain) rafMain = requestAnimationFrame(() => { rafMain = 0; renderMain(); }); }
function renderOverSoon() { if (!rafOver) rafOver = requestAnimationFrame(() => { rafOver = 0; renderOver(); }); }

/* ---------- タイル（描いた内容を小さな画像に分けて覚えておく） ----------
   スクロール中は覚えた画像を並べ直すだけなので、線を描き直さない。
   ズーム中は前の倍率の画像を伸び縮みさせて見せ、止まったらその倍率で描き直す。
   線が変わったら、その範囲のタイルだけ捨てる。 */
const TILE = 256;            // タイルの大きさ（画面px）
const TILE_MAX = 160;        // 覚えておく枚数の上限（古いものから捨てる）
const tiles = new Map();     // key -> { cv, x0, y0, x1, y1 }（x0.. はワールド座標の範囲）
let tileLevel = 0;           // 今使っているタイルの倍率
let lastZoomAt = 0, idleTimer = 0;
function clearTiles() {
  for (const t of tiles.values()) t.cv.width = 0;
  tiles.clear();
}
function invalidateTiles(bb) {
  for (const [k, t] of tiles) {
    if (t.x1 < bb.x0 || t.x0 > bb.x1 || t.y1 < bb.y0 || t.y0 > bb.y1) continue;
    t.cv.width = 0;
    tiles.delete(k);
  }
}
function renderTile(L, tx, ty) {
  const ts = TILE / L, x0 = tx * ts, y0 = ty * ts, x1 = x0 + ts, y1 = y0 + ts;
  const px = Math.ceil(TILE * DPR), cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const c = cv.getContext('2d');
  c.setTransform(L * DPR, 0, 0, L * DPR, -x0 * L * DPR, -y0 * L * DPR);
  c.fillStyle = T.paper;
  c.fillRect(x0, y0, ts, ts);
  drawBg(c, { x0, y0, x1, y1 }, L, S.board.bg);
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const st of S.strokes) {
    const b = bbox(st);
    if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
    drawStroke(c, st);
  }
  return { cv, x0, y0, x1, y1 };
}
// ズームが止まったら、その倍率で描き直す
function noteZoom() {
  lastZoomAt = performance.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(renderMainSoon, 180);
}

function renderMain() {
  if (!S.board) return;
  const v = S.view, sel = S.sel;
  $('#zoom').textContent = Math.round(v.s * 100) + '%';
  // 選択した線を動かしている間は、その線を除いて直接描く
  if (sel && (sel.dx || sel.dy || sel.preview)) { renderDirect(); return; }

  const zooming = performance.now() - lastZoomAt < 170;
  const k0 = v.s / (tileLevel || v.s);
  if (!tileLevel || (!zooming && tileLevel !== v.s) || k0 > 2 || k0 < 0.5) tileLevel = v.s;
  const L = tileLevel, k = v.s / L, ts = TILE / L, r = viewRect();
  const c = mc;
  // タイルがまだ無い所のための下地
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.fillStyle = T.paper;
  c.fillRect(0, 0, W, H);
  c.setTransform(DPR * v.s, 0, 0, DPR * v.s, DPR * v.x, DPR * v.y);
  drawBg(c, r, v.s, S.board.bg);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.imageSmoothingEnabled = true;
  // 動いている間は1コマに作る枚数を絞る（残りは次のコマで）
  let budget = zooming || performance.now() - lastPanAt < 120 ? 6 : Infinity, missing = false;
  const tx0 = Math.floor(r.x0 / ts), tx1 = Math.floor(r.x1 / ts), ty0 = Math.floor(r.y0 / ts), ty1 = Math.floor(r.y1 / ts);
  const size = TILE * k * DPR;
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const key = L + '|' + tx + '|' + ty;
    let t = tiles.get(key);
    if (t) { tiles.delete(key); tiles.set(key, t); } // 最近使ったものを後ろへ
    else if (budget > 0) {
      budget--;
      t = renderTile(L, tx, ty);
      tiles.set(key, t);
      if (tiles.size > TILE_MAX) { const [ok, ot] = tiles.entries().next().value; ot.cv.width = 0; tiles.delete(ok); }
    } else { missing = true; continue; }
    const sx = (tx * ts * v.s + v.x) * DPR, sy = (ty * ts * v.s + v.y) * DPR;
    if (k === 1) c.drawImage(t.cv, Math.round(sx), Math.round(sy));
    else c.drawImage(t.cv, sx, sy, size, size);
  }
  if (missing) renderMainSoon();
}

// タイルを使わずに全部描く（選択した線を動かしている間）
function renderDirect() {
  const c = mc, v = S.view;
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.fillStyle = T.paper;
  c.fillRect(0, 0, W, H);
  c.setTransform(DPR * v.s, 0, 0, DPR * v.s, DPR * v.x, DPR * v.y);
  const r = viewRect();
  drawBg(c, r, v.s, S.board.bg);
  c.lineCap = 'round'; c.lineJoin = 'round';
  const sel = S.sel, moving = sel && (sel.dx || sel.dy || sel.preview);
  for (const st of S.strokes) {
    if (moving && sel.set.has(st)) continue;
    const b = bbox(st);
    if (b.x1 < r.x0 || b.x0 > r.x1 || b.y1 < r.y0 || b.y0 > r.y1) continue;
    drawStroke(c, st);
  }
  if (moving && sel.preview) for (const st of sel.preview) drawStroke(c, st);
  else if (moving) {
    c.translate(sel.dx, sel.dy);
    for (const st of sel.set) drawStroke(c, st);
  }
}

// 書き足した線を、今の画面にそのまま描き足す（全体の描き直しが予定されていればそちらに任せる）
function appendToMain(st) {
  invalidateTiles(bbox(st)); // その範囲のタイルは次に描くときに作り直す
  if (rafMain || !S.board) { renderMainSoon(); return; }
  const v = S.view;
  mc.setTransform(DPR * v.s, 0, 0, DPR * v.s, DPR * v.x, DPR * v.y);
  mc.lineCap = 'round'; mc.lineJoin = 'round';
  drawStroke(mc, st);
}

let hover = null; // マウス／ペンのホバー位置（消しゴムのカーソル用）

function renderOver() {
  const c = oc, v = S.view;
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.clearRect(0, 0, W, H);

  // 描画中の線
  if (S.cur) {
    c.setTransform(DPR * v.s, 0, 0, DPR * v.s, DPR * v.x, DPR * v.y);
    c.lineCap = 'round'; c.lineJoin = 'round';
    geo.delete(S.cur);
    drawStroke(c, S.cur);
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // 投げ縄
  if (S.lasso && S.lasso.length > 2) {
    c.beginPath();
    S.lasso.forEach((p, i) => { const s = toScreen(p.x, p.y); i ? c.lineTo(s.x, s.y) : c.moveTo(s.x, s.y); });
    c.closePath();
    c.fillStyle = T.accentSoft; c.fill();
    c.setLineDash([6, 5]); c.lineWidth = 1.5; c.strokeStyle = T.accent; c.stroke(); c.setLineDash([]);
  }

  // 選択範囲
  const sb = $('#selbar');
  if (S.sel) {
    const bb = selDisplayBB();
    const a = toScreen(bb.x0, bb.y0), b = toScreen(bb.x1, bb.y1), rot = S.sel.rot;
    c.setLineDash([6, 5]); c.lineWidth = 1.5; c.strokeStyle = T.accent;
    if (rot) {
      const o = toScreen(rot.cx, rot.cy);
      c.save(); c.translate(o.x, o.y); c.rotate(rot.a); c.translate(-o.x, -o.y);
      c.strokeRect(a.x - 6, a.y - 6, b.x - a.x + 12, b.y - a.y + 12);
      c.restore();
      let deg = Math.round(rot.a * 180 / Math.PI) % 360;
      if (deg > 180) deg -= 360; else if (deg <= -180) deg += 360;
      c.font = '600 13px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.lineWidth = 4; c.strokeStyle = T.paper; c.strokeText(deg + '°', o.x, o.y);
      c.fillStyle = T.accent; c.fillText(deg + '°', o.x, o.y);
      c.lineWidth = 1.5;
    } else c.strokeRect(a.x - 6, a.y - 6, b.x - a.x + 12, b.y - a.y + 12);
    c.setLineDash([]);
    const busy = act && (act.type === 'move' || act.type === 'scale' || act.type === 'rotate');
    // 回転のつまみ
    if (!act && canRotate()) {
      const p = rotHandlePos({ x0: a.x - 6, y0: a.y - 6, x1: b.x + 6, y1: b.y + 6 });
      c.strokeStyle = T.accent; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(p.x, a.y - 6); c.lineTo(p.x, p.y + 6); c.stroke();
      c.fillStyle = T.paper;
      c.beginPath(); c.arc(p.x, p.y, 6, 0, Math.PI * 2); c.fill(); c.stroke();
    }
    // 拡大縮小のつまみ
    if (!act || (act.type !== 'move' && act.type !== 'rotate')) {
      const rr = { x0: a.x - 6, y0: a.y - 6, x1: b.x + 6, y1: b.y + 6 };
      for (const h of HANDLES) {
        if ((!h.cx && rr.x1 - rr.x0 < 60) || (!h.cy && rr.y1 - rr.y0 < 60)) continue;
        const p = handlePos(h, rr);
        c.fillStyle = T.paper; c.strokeStyle = T.accent; c.lineWidth = 1.5;
        c.beginPath(); c.rect(p.x - 5, p.y - 5, 10, 10); c.fill(); c.stroke();
      }
    }
    if (busy) sb.hidden = true;
    else {
      sb.hidden = false;
      const bw = sb.offsetWidth, bh = sb.offsetHeight;
      let x = (a.x + b.x) / 2 - bw / 2, y = a.y - bh - 16 - (canRotate() ? ROT_GAP + 6 : 0); // 回転のつまみの上へ
      if (y < 60) y = b.y + 16;
      sb.style.left = clamp(x, 8, W - bw - 8) + 'px';
      sb.style.top = clamp(y, 60, H - bh - 80) + 'px';
    }
  } else sb.hidden = true;

  // 定規
  if (S.ruler.on) drawRuler(c);

  // 消しゴムのカーソル
  if (S.tool === 'eraser' && hover) {
    c.beginPath();
    c.arc(hover.x, hover.y, S.eraser.size, 0, Math.PI * 2);
    c.fillStyle = T.eraserFill; c.fill();
    c.lineWidth = 1; c.strokeStyle = T.eraserLine; c.stroke();
  }
}

/* 定規は ruler.js */
/* =========================================================
   履歴
   ========================================================= */
// added：線を1本書き足しただけのとき、その線（保存と描画を軽くする）
function pushUndo(before, added) {
  S.undo.push(before);
  if (S.undo.length > 200) S.undo.shift();
  S.redo.length = 0;
  changed(added);
}
function undo() {
  if (!S.undo.length) return;
  S.redo.push(S.strokes); S.strokes = S.undo.pop(); S.sel = null; changed();
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(S.strokes); S.strokes = S.redo.pop(); S.sel = null; changed();
}
function updateHistoryButtons() {
  $('#btn-undo').disabled = !S.undo.length;
  $('#btn-redo').disabled = !S.redo.length;
}

/* =========================================================
   保存
   ========================================================= */
/* 保存のしかた
   ・線を1本書き足した → その線だけを pending にすぐ追記（軽い）。ボード全体は手を止めて
     COMPACT_MS 後にまとめて書く
   ・消す・動かす・元に戻すなど → ボード全体をすぐ書く
   ・表示位置（スクロール・ズーム）→ localStorage に少し待ってから（ボード全体は書かない） */
const COMPACT_MS = 3000;
let saveTimer = 0, viewTimer = 0;
function changed(added) {
  if (S.board) S.board.updatedAt = Date.now();
  updateHistoryButtons();
  if (added && S.board) {
    Store.addPending(S.board.id, added).catch(err => toast('保存に失敗しました: ' + err.message));
    scheduleSave(COMPACT_MS);
    appendToMain(added); // 画面全体は描き直さず、その線だけ描き足す
    renderOverSoon();
  } else {
    saveNow();
    clearTiles();
    render();
  }
  window.Sync?.changed();
}
function scheduleSave(ms = 500) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, ms);
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!S.board) return;
  S.board.strokes = S.strokes;
  S.board.view = { ...S.view };
  persistBoard(S.board);
}
// 表示位置はボードごとに localStorage へ（ボード全体を書き直さない）
function saveView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { if (S.board) LS.set('view:' + S.board.id, S.view); }, 400);
}
// 書き込みは1つずつ。書き込み中に来たものは、終わってからまとめて書く
let saving = null;
const pendingBoards = new Set();
function persistBoard(b) {
  if (saving) { pendingBoards.add(b); return; }
  saving = Store.put(b)
    .catch(err => toast('保存に失敗しました: ' + err.message))
    .finally(() => {
      saving = null;
      const next = [...pendingBoards];
      pendingBoards.clear();
      next.forEach(persistBoard);
    });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
window.addEventListener('pagehide', saveNow);

/* =========================================================
   消しゴム
   ========================================================= */
function distPtSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
function segsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function distSegSeg(a, b, c, d) {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(
    distPtSeg(a.x, a.y, c.x, c.y, d.x, d.y), distPtSeg(b.x, b.y, c.x, c.y, d.x, d.y),
    distPtSeg(c.x, c.y, a.x, a.y, b.x, b.y), distPtSeg(d.x, d.y, a.x, a.y, b.x, b.y));
}
function strokeHits(st, a, b, r) {
  const p = st.p;
  if (p.length === 3) return distPtSeg(p[0], p[1], a.x, a.y, b.x, b.y) <= r;
  for (let i = 3; i < p.length; i += 3) {
    if (distSegSeg({ x: p[i - 3], y: p[i - 2] }, { x: p[i], y: p[i + 1] }, a, b) <= r) return true;
  }
  return false;
}
function densify(p, step) {
  const out = [p[0], p[1], p[2]];
  for (let i = 3; i < p.length; i += 3) {
    const x0 = p[i - 3], y0 = p[i - 2], x1 = p[i], y1 = p[i + 1];
    const k = Math.floor(Math.hypot(x1 - x0, y1 - y0) / step);
    for (let j = 1; j < k; j++) {
      const t = j / k;
      out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p[i - 1] + (p[i + 2] - p[i - 1]) * t);
    }
    out.push(x1, y1, p[i + 2]);
  }
  return out;
}
// 部分消し：消しゴムが通った所でストロークを分割する。変化がなければ null
function splitStroke(st, a, b, r) {
  const rr = r + st.w / 2;
  const p = densify(st.p, Math.max(rr / 2, 0.3));
  const parts = [];
  let curr = [], hit = false;
  for (let i = 0; i < p.length; i += 3) {
    if (distPtSeg(p[i], p[i + 1], a.x, a.y, b.x, b.y) <= rr) {
      hit = true;
      if (curr.length) { parts.push(curr); curr = []; }
    } else curr.push(p[i], p[i + 1], p[i + 2]);
  }
  if (!hit) return null;
  if (curr.length) parts.push(curr);
  return parts.filter(q => q.length > 3).map(q => ({ ...st, id: uid(), p: q }));
}
function eraseTo(x, y) {
  const w = toWorld(x, y), a = act.last || w;
  act.last = w;
  const r = S.eraser.size / S.view.s;
  const ex0 = Math.min(a.x, w.x) - r, ex1 = Math.max(a.x, w.x) + r;
  const ey0 = Math.min(a.y, w.y) - r, ey1 = Math.max(a.y, w.y) + r;
  const partial = S.eraser.mode === 'partial';
  let didChange = false;
  const res = [], hit = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; // 変わった線の範囲
  const grow = b => { hit.x0 = Math.min(hit.x0, b.x0); hit.y0 = Math.min(hit.y0, b.y0); hit.x1 = Math.max(hit.x1, b.x1); hit.y1 = Math.max(hit.y1, b.y1); };
  for (const st of S.strokes) {
    const bb = bbox(st);
    if (isImg(st) || bb.x1 < ex0 || bb.x0 > ex1 || bb.y1 < ey0 || bb.y0 > ey1) { res.push(st); continue; } // 画像は消しゴムでは消さない
    if (partial) {
      const parts = splitStroke(st, a, w, r);
      if (parts) { didChange = true; grow(bb); res.push(...parts); } else res.push(st);
    } else if (strokeHits(st, a, w, r + st.w / 2)) { didChange = true; grow(bb); }
    else res.push(st);
  }
  if (didChange) { S.strokes = res; act.changed = true; invalidateTiles(hit); renderMainSoon(); }
}

/* =========================================================
   投げ縄・選択
   ========================================================= */
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function selectByLasso(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  // 線の一部でも投げ縄の中に入っていれば選択
  const set = new Set();
  for (const st of S.strokes) {
    const b = bbox(st);
    if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
    if (strokeTouchesPoly(st, poly)) set.add(st);
  }
  setSelection(set.size ? set : null);
}
function strokeTouchesPoly(st, poly) {
  if (isImg(st)) return imgTouchesPoly(st, poly);
  const p = st.p, n = p.length / 3;
  for (let i = 0; i < n; i++) if (pointInPoly(p[i * 3], p[i * 3 + 1], poly)) return true;
  // 点と点の間だけが中を通っている場合（素早く描いた線など）
  for (let i = 1; i < n; i++) {
    const a = { x: p[i * 3 - 3], y: p[i * 3 - 2] }, b = { x: p[i * 3], y: p[i * 3 + 1] };
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) if (segsCross(a, b, poly[j], poly[k])) return true;
  }
  return false;
}
function setSelection(set) {
  if (!set) { S.sel = null; renderOverSoon(); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of set) {
    const b = bbox(st);
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  S.sel = { set, bb: { x0, y0, x1, y1 }, dx: 0, dy: 0 };
  renderSelColors();
  renderOverSoon();
}
/* ---------- 選択範囲の拡大縮小（点の位置だけ変えるので線の太さはそのまま） ----------
   四隅：縦横比を保つ（Shift を押しながらだと自由）、辺の中央：横だけ／縦だけ */
const HANDLES = [
  { cx: -1, cy: -1, cur: 'nwse-resize' }, { cx: 1, cy: -1, cur: 'nesw-resize' },
  { cx: -1, cy: 1, cur: 'nesw-resize' }, { cx: 1, cy: 1, cur: 'nwse-resize' },
  { cx: 0, cy: -1, cur: 'ns-resize' }, { cx: 0, cy: 1, cur: 'ns-resize' },
  { cx: -1, cy: 0, cur: 'ew-resize' }, { cx: 1, cy: 0, cur: 'ew-resize' },
];
function selScreenRect() {
  const bb = S.sel.bb, a = toScreen(bb.x0, bb.y0), b = toScreen(bb.x1, bb.y1);
  return { x0: a.x - 6, y0: a.y - 6, x1: b.x + 6, y1: b.y + 6 };
}
function handlePos(h, r) {
  return { x: h.cx < 0 ? r.x0 : h.cx > 0 ? r.x1 : (r.x0 + r.x1) / 2, y: h.cy < 0 ? r.y0 : h.cy > 0 ? r.y1 : (r.y0 + r.y1) / 2 };
}
function handleAt(x, y, pointerType) {
  if (!S.sel) return null;
  const r = selScreenRect(), rad = pointerType === 'touch' ? 22 : 12;
  // 小さい選択では辺の中央のつまみが四隅と重なるので、四隅を優先
  for (const h of HANDLES) {
    if (!h.cx || !h.cy) { if (r.x1 - r.x0 < 60 && !h.cx) continue; if (r.y1 - r.y0 < 60 && !h.cy) continue; }
    const p = handlePos(h, r);
    if (Math.abs(x - p.x) <= rad && Math.abs(y - p.y) <= rad) return h;
  }
  return null;
}
function scaleStroke(st, ax, ay, sx, sy) {
  const p = st.p.slice();
  for (let i = 0; i < p.length; i += 3) { p[i] = ax + (p[i] - ax) * sx; p[i + 1] = ay + (p[i + 1] - ay) * sy; }
  return { ...st, p };
}
function startScale(h, pid, x, y) {
  // 線の太さの分の余白を含まない、点の範囲を基準にする（拡大縮小しても位置がずれない）
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of S.sel.set) for (let i = 0; i < st.p.length; i += 3) {
    x0 = Math.min(x0, st.p[i]); x1 = Math.max(x1, st.p[i]); y0 = Math.min(y0, st.p[i + 1]); y1 = Math.max(y1, st.p[i + 1]);
  }
  if (x1 - x0 < 1e-6) x1 = x0 + 1e-6;
  if (y1 - y0 < 1e-6) y1 = y0 + 1e-6;
  act = {
    type: 'scale', pid, h, w0: toWorld(x, y),
    ax: h.cx < 0 ? x1 : x0, ay: h.cy < 0 ? y1 : y0,   // 反対側を固定
    hx: h.cx < 0 ? x0 : x1, hy: h.cy < 0 ? y0 : y1,   // つまみ側
  };
}
function updateScale(e) {
  const w = toWorld(e.clientX, e.clientY), a = act;
  const MIN = 0.02;
  // つまみ側の点を、指（マウス）が動いた分だけ動かしたときの倍率
  const tx = a.hx + (w.x - a.w0.x), ty = a.hy + (w.y - a.w0.y);
  let sx = 1, sy = 1;
  if (a.h.cx && a.h.cy && !e.shiftKey) {
    const vx = a.hx - a.ax, vy = a.hy - a.ay;
    sx = sy = Math.max(MIN, ((tx - a.ax) * vx + (ty - a.ay) * vy) / (vx * vx + vy * vy));
  } else {
    if (a.h.cx) sx = Math.max(MIN, (tx - a.ax) / (a.hx - a.ax));
    if (a.h.cy) sy = Math.max(MIN, (ty - a.ay) / (a.hy - a.ay));
    // 画像が入っているときは、辺のつまみでも縦横比を保つ（画像がゆがまないように）
    if (!(a.h.cx && a.h.cy) && [...S.sel.set].some(isImg)) { if (a.h.cx) sy = sx; else sx = sy; }
  }
  S.sel.tf = { ax: a.ax, ay: a.ay, sx, sy };
  S.sel.preview = [...S.sel.set].map(st => scaleStroke(st, a.ax, a.ay, sx, sy));
  render();
}
function commitScale() {
  const tf = S.sel.tf;
  S.sel.tf = null; S.sel.preview = null;
  if (!tf || (tf.sx === 1 && tf.sy === 1)) { render(); return; }
  mapSelection(st => scaleStroke(st, tf.ax, tf.ay, tf.sx, tf.sy));
}
/* ---------- 選択範囲の回転（枠の上のまるいつまみ。Shift で 15° ずつ、30° と 45° の倍数の近くでは吸い付く） ----------
   画像は回せないので、画像が入っているときはつまみを出さない */
const ROT_GAP = 28; // 選択枠の上辺からつまみまで（画面px）
const canRotate = () => S.sel && ![...S.sel.set].some(isImg);
const rotHandlePos = r => ({ x: (r.x0 + r.x1) / 2, y: r.y0 - ROT_GAP });
function rotHandleAt(x, y, pointerType) {
  if (!canRotate()) return false;
  const p = rotHandlePos(selScreenRect());
  return Math.hypot(x - p.x, y - p.y) <= (pointerType === 'touch' ? 22 : 12);
}
function rotateStroke(st, cx, cy, a) {
  const p = st.p.slice(), cos = Math.cos(a), sin = Math.sin(a);
  for (let i = 0; i < p.length; i += 3) {
    const dx = p[i] - cx, dy = p[i + 1] - cy;
    p[i] = cx + dx * cos - dy * sin; p[i + 1] = cy + dx * sin + dy * cos;
  }
  return { ...st, p };
}
function startRotate(pid, x, y) {
  const bb = S.sel.bb, cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2, w = toWorld(x, y);
  act = { type: 'rotate', pid, cx, cy, a0: Math.atan2(w.y - cy, w.x - cx) };
}
function updateRotate(e) {
  const w = toWorld(e.clientX, e.clientY), a = act;
  let ang = Math.atan2(w.y - a.cy, w.x - a.cx) - a.a0;
  if (e.shiftKey) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
  else {
    // 30° と 45° の倍数（30, 45, 60, 90, 120, 135 …）の近くでは吸い付く
    const deg = ang * 180 / Math.PI;
    for (const step of [30, 45]) {
      const q = Math.round(deg / step) * step;
      if (Math.abs(deg - q) < 3) { ang = q * Math.PI / 180; break; }
    }
  }
  S.sel.rot = { cx: a.cx, cy: a.cy, a: ang };
  S.sel.preview = [...S.sel.set].map(st => rotateStroke(st, a.cx, a.cy, ang));
  render();
}
function commitRotate() {
  const rot = S.sel.rot;
  S.sel.rot = null; S.sel.preview = null;
  const n = rot ? Math.round(rot.a / (2 * Math.PI)) * 2 * Math.PI : 0;
  if (!rot || Math.abs(rot.a - n) < 1e-9) { render(); return; }
  mapSelection(st => rotateStroke(st, rot.cx, rot.cy, rot.a));
}
// 表示用：拡大縮小・移動中の選択範囲（ワールド座標）
function selDisplayBB() {
  const { bb, dx, dy, tf } = S.sel;
  if (!tf) return { x0: bb.x0 + dx, y0: bb.y0 + dy, x1: bb.x1 + dx, y1: bb.y1 + dy };
  const X = v => tf.ax + (v - tf.ax) * tf.sx, Y = v => tf.ay + (v - tf.ay) * tf.sy;
  return { x0: Math.min(X(bb.x0), X(bb.x1)), y0: Math.min(Y(bb.y0), Y(bb.y1)), x1: Math.max(X(bb.x0), X(bb.x1)), y1: Math.max(Y(bb.y0), Y(bb.y1)) };
}

function inSelection(x, y) {
  if (!S.sel) return false;
  const a = toScreen(S.sel.bb.x0, S.sel.bb.y0), b = toScreen(S.sel.bb.x1, S.sel.bb.y1);
  return x >= a.x - 10 && x <= b.x + 10 && y >= a.y - 10 && y <= b.y + 10;
}
// 選択中のストロークを fn で置き換える
function mapSelection(fn) {
  const before = S.strokes.slice(), ns = new Set();
  S.strokes = S.strokes.map(st => {
    if (!S.sel.set.has(st)) return st;
    const n = fn(st); ns.add(n); return n;
  });
  setSelection(ns);
  pushUndo(before);
}
function commitMove() {
  const { dx, dy } = S.sel;
  S.sel.dx = S.sel.dy = 0;
  if (!dx && !dy) { render(); return; }
  mapSelection(st => {
    const p = st.p.slice();
    for (let i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 1] += dy; }
    return { ...st, p };
  });
}
function deleteSelection() {
  if (!S.sel) return;
  const before = S.strokes.slice();
  S.strokes = S.strokes.filter(st => !S.sel.set.has(st));
  S.sel = null;
  pushUndo(before);
}
function duplicateSelection() {
  if (!S.sel) return;
  const before = S.strokes.slice(), off = 24 / S.view.s, ns = new Set(), newGroup = new Map();
  for (const st of S.strokes) {
    if (!S.sel.set.has(st)) continue;
    const p = st.p.slice();
    for (let i = 0; i < p.length; i += 3) { p[i] += off; p[i + 1] += off; }
    const n = { ...st, id: uid(), p };
    if (st.g) { if (!newGroup.has(st.g)) newGroup.set(st.g, uid()); n.g = newGroup.get(st.g); } // 複製は別のまとまり
    ns.add(n);
  }
  S.strokes = S.strokes.concat([...ns]);
  setSelection(ns);
  pushUndo(before);
}
function recolorSelection(color) {
  if (S.sel) mapSelection(st => (isImg(st) ? st : { ...st, c: color }));
}

/* ---------- テンプレート：よく使う図（ベンゼン環など）を保存して、すぐ呼び出す ----------
   保存するのは線だけ（画像は容量を食うので入れない）。左上を (0, 0) にそろえて持つ
   端末内は localStorage、ログイン中は sync.js がクラウドの1ドキュメントと同期する
   { id, name, strokes, updatedAt, deleted } … 消したものも印だけ残す（ほかの端末に伝えるため） */
let templates = LS.get('templates', []);
const liveTemplates = () => templates.filter(t => !t.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
function saveTemplates() {
  LS.set('templates', templates);
  if (!$('#pop-tpl').hidden) renderTemplates();
  if (window.Sync && window.Sync.templatesChanged) window.Sync.templatesChanged();
}
function saveSelectionAsTemplate() {
  if (!S.sel) return;
  const lines = S.strokes.filter(st => S.sel.set.has(st) && !isImg(st));
  if (!lines.length) { toast('画像はテンプレートに入れられません'); return; }
  const name = (prompt('テンプレートの名前', '') || '').trim();
  if (!name) return;
  const b = contentBox(lines), r2 = v => Math.round(v * 100) / 100;
  const strokes = lines.map(st => {
    const p = st.p.slice();
    for (let i = 0; i < p.length; i += 3) { p[i] = r2(p[i] - b.x0); p[i + 1] = r2(p[i + 1] - b.y0); }
    const n = { ...st, p };
    delete n.id; delete n.g;
    return n;
  });
  templates.push({ id: uid(), name, strokes, updatedAt: Date.now() });
  saveTemplates();
  toast(lines.length < S.sel.set.size ? `「${name}」を保存しました（画像は除きました）` : `「${name}」を保存しました`);
}
// 画面の真ん中に置いて、そのまま動かせるよう選んだ状態にする
function placeTemplate(t) {
  closePops();
  const b = contentBox(t.strokes);
  if (!b) return;
  const c = toWorld(W / 2, H / 2), ox = c.x - (b.x0 + b.x1) / 2, oy = c.y - (b.y0 + b.y1) / 2;
  const items = t.strokes.map(st => {
    const p = st.p.slice();
    for (let i = 0; i < p.length; i += 3) { p[i] += ox; p[i + 1] += oy; }
    return { ...st, id: uid(), p };
  });
  const before = S.strokes.slice();
  S.strokes = S.strokes.concat(items);
  pushUndo(before);
  setTool('lasso');
  setSelection(new Set(items));
}
async function deleteTemplate(t) {
  const ok = await askChoice('テンプレートを削除', `「${t.name}」を削除しますか？`, [
    { label: 'キャンセル', value: false }, { label: '削除', value: true, primary: true },
  ]);
  if (!ok) return;
  Object.assign(t, { deleted: true, strokes: [], updatedAt: Date.now() });
  saveTemplates();
}
function renderTemplates() {
  const box = $('#tpl-list'), list = liveTemplates();
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="hint">投げ縄で線を選んで、選択バーの「テンプレートに保存」から追加できます（画像は入れられません）。</p>';
    return;
  }
  for (const t of list) {
    const li = document.createElement('div');
    li.className = 'tpl';
    li.innerHTML = '<button class="tpl-use"><canvas></canvas><span></span></button><button class="ibtn" data-icon="trash" title="削除"></button>';
    li.querySelector('span').textContent = t.name;
    drawThumb(li.querySelector('canvas'), t.strokes);
    const [use, del] = li.querySelectorAll('button');
    use.onclick = () => placeTemplate(t);
    del.onclick = () => deleteTemplate(t);
    fillIcons(li);
    box.appendChild(li);
  }
}
function drawThumb(cv, strokes) {
  const size = 56, pad = 5, dpr = window.devicePixelRatio || 1, b = contentBox(strokes);
  cv.width = cv.height = size * dpr;
  cv.style.width = cv.style.height = size + 'px';
  if (!b) return;
  const c = cv.getContext('2d');
  const k = Math.min((size - pad * 2) / (b.x1 - b.x0 || 1), (size - pad * 2) / (b.y1 - b.y0 || 1));
  c.setTransform(k * dpr, 0, 0, k * dpr, (size / 2 - (b.x0 + b.x1) / 2 * k) * dpr, (size / 2 - (b.y0 + b.y1) / 2 * k) * dpr);
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const st of strokes) drawStroke(c, st);
}

/* =========================================================
   入力（マウス・ペン・タッチ）
   ========================================================= */
const ptrs = new Map();
let act = null;
let spaceDown = false;

const fingerPans = () => S.finger === 'never' || (S.finger === 'auto' && S.penSeen);
const touchList = () => [...ptrs.entries()].filter(([, p]) => p.type === 'touch');

function startPinch(touches) {
  const [[ida, a], [idb, b]] = touches;
  const onRuler = S.ruler.on && rulerHit(a.x, a.y) && rulerHit(b.x, b.y);
  act = {
    type: onRuler ? 'ruler-pinch' : 'pinch', ids: [ida, idb],
    v0: { ...S.view }, r0: { ...S.ruler },
    m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    d0: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
    ang0: Math.atan2(b.y - a.y, b.x - a.x),
  };
}
function updatePinch() {
  const a = ptrs.get(act.ids[0]), b = ptrs.get(act.ids[1]);
  if (!a || !b) return;
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (act.type === 'ruler-pinch') {
    S.ruler.wx = act.r0.wx + (m.x - act.m0.x) / S.view.s;
    S.ruler.wy = act.r0.wy + (m.y - act.m0.y) / S.view.s;
    S.ruler.a = act.r0.a; // 回す前の向きに戻してから、中心を軸に回す
    setRulerAngle(act.r0.a + Math.atan2(b.y - a.y, b.x - a.x) - act.ang0);
    renderOverSoon();
    return;
  }
  const d = Math.hypot(b.x - a.x, b.y - a.y), v0 = act.v0;
  const s = clamp(v0.s * d / act.d0, 0.05, 16);
  const wx = (act.m0.x - v0.x) / v0.s, wy = (act.m0.y - v0.y) / v0.s;
  S.view = { x: m.x - wx * s, y: m.y - wy * s, s };
  viewChanged();
}
let lastPanAt = 0, prevScale = 0;
// 表示位置を画面のピクセルの区切りにそろえる（タイルの画像がずれずにぴったり並ぶ）
function snapView() {
  S.view.x = Math.round(S.view.x * DPR) / DPR;
  S.view.y = Math.round(S.view.y * DPR) / DPR;
}
function viewChanged() {
  snapView();
  lastPanAt = performance.now();
  if (S.view.s !== prevScale) { prevScale = S.view.s; noteZoom(); }
  saveView(); render();
}

function zoomAt(x, y, f) {
  const v = S.view, s = clamp(v.s * f, 0.05, 16);
  f = s / v.s;
  S.view = { x: x - (x - v.x) * f, y: y - (y - v.y) * f, s };
  viewChanged();
}

function cancelAction() {
  if (!act) return;
  if (act.type === 'draw') S.cur = null;
  if (act.type === 'erase' && act.changed) { S.strokes = act.before; clearTiles(); }
  if (act.type === 'lasso') S.lasso = null;
  if (act.type === 'move') { S.sel.dx = S.sel.dy = 0; }
  if (act.type === 'scale' && S.sel) { S.sel.tf = null; S.sel.preview = null; }
  if (act.type === 'rotate' && S.sel) { S.sel.rot = null; S.sel.preview = null; }
  act = null;
  render();
}

function onDown(e) {
  closePops();
  if (!S.board) return;
  try { over.setPointerCapture(e.pointerId); } catch {}
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  if (e.pointerType === 'pen') {
    S.penSeen = true;
    // 手のひらが先に触れていても、ペンを優先する
    if (act && (act.type === 'block' || act.type === 'pinch' || ptrs.get(act.pid)?.type === 'touch')) cancelAction();
  }

  // 2本指 → ズーム・スクロール（ペンで描いている最中のタッチは無視＝パームリジェクション）
  if (e.pointerType === 'touch') {
    const ts = touchList();
    if (ts.length >= 2) {
      const touchAct = act && act.pid !== undefined && ptrs.get(act.pid)?.type === 'touch';
      if (!act || touchAct || act.type === 'block') { cancelAction(); startPinch(ts.slice(-2)); }
      return;
    }
    if (act && act.type !== 'block') return;
  }
  if (act) return;

  // ペンが近づいただけ（筆圧がほぼ 0）では始めない。筆圧が出た時点から始める
  if (e.pointerType === 'pen' && !penTouching(e)) { act = { type: 'penwait', pid: e.pointerId }; return; }
  startAction(e);
}

/* ---------- ペンが本当に触れているか ----------
   ペンによっては、触れる少し手前から「押した」と知らせてくる（そのときの筆圧は 0 かごく小さい）。
   筆圧が S.penMin 以上なら触れているとみなす。書いている途中は 7 割まで下がるまで続ける（途切れにくく） */
const penTouching = (e, keep = false) => S.penMin <= 0 || e.pressure >= (keep ? S.penMin * 0.7 : S.penMin);
// 書いている途中でペンが浮いた → そこで終えて、また触れるのを待つ
function liftPen(e) {
  const a = act;
  act = { type: 'penwait', pid: e.pointerId };
  endAction(a, e);
}

function startAction(e) {
  const x = e.clientX, y = e.clientY;
  if (e.button === 1 || spaceDown || S.tool === 'hand' || (e.pointerType === 'touch' && fingerPans())) {
    act = { type: 'pan', pid: e.pointerId, lx: x, ly: y };
    setCursor();
    return;
  }
  if (e.button !== 0 && e.pointerType === 'mouse') return;

  const rh = rulerHit(x, y);
  if (rh) {
    const o = rulerOrigin();
    act = rh === 'knob'
      ? { type: 'ruler-rot', pid: e.pointerId, off: Math.atan2(y - o.y, x - o.x) - S.ruler.a }
      : { type: 'ruler-move', pid: e.pointerId, gx: S.ruler.wx - x / S.view.s, gy: S.ruler.wy - y / S.view.s };
    return;
  }

  // ペンのおしり（消しゴムボタン）は一時的に消しゴム
  const tool = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32)) ? 'eraser' : S.tool;
  switch (tool) {
    case 'pen': case 'hl': {
      S.sel = null;
      const cfg = S.tool === 'hl' ? S.hl : S.pen;
      const st = { id: uid(), t: S.tool, c: cfg.color, w: cfg.width, pr: S.tool === 'pen' && e.pointerType === 'pen' && S.pen.pressure !== false, p: [] };
      act = { type: 'draw', pid: e.pointerId, st, snap: S.ruler.on ? rulerSnapSide(x, y) : 0, curve: curveSnapStart(x, y) };
      S.cur = st;
      addPoint(e);
      renderOverSoon();
      break;
    }
    case 'eraser':
      S.sel = null;
      act = { type: 'erase', pid: e.pointerId, before: S.strokes, changed: false, last: null };
      hover = { x, y };
      eraseTo(x, y);
      renderOverSoon();
      break;
    case 'lasso': {
      const h = handleAt(x, y, e.pointerType);
      if (rotHandleAt(x, y, e.pointerType)) startRotate(e.pointerId, x, y);
      else if (h) startScale(h, e.pointerId, x, y);
      else if (inSelection(x, y)) {
        const w = toWorld(x, y);
        act = { type: 'move', pid: e.pointerId, sx: w.x, sy: w.y };
      } else {
        S.sel = null;
        act = { type: 'lasso', pid: e.pointerId };
        S.lasso = [toWorld(x, y)];
      }
      renderOverSoon();
      break;
    }
  }
}

function addPoint(e) {
  const st = act.st;
  let x = e.clientX, y = e.clientY;
  if (act.snap) ({ x, y } = rulerProject(x, y, act.snap, st.w * S.view.s));
  else if (act.curve) {
    const r = curveSnapMove(x, y, act.curve);
    if (r) { act.curve = r.hint; x = r.x; y = r.y; }
  }
  let w = toWorld(x, y);
  const pr = st.pr ? (e.pressure || 0.5) : 0.5;
  // 手ぶれ補正（書いている間）：ペン先を少し遅れて追いかけ、細かい揺れを吸収する（定規に沿うときはしない）
  if (!act.snap && !act.curve && S.smooth > 0) {
    act.raw = { x: w.x, y: w.y, pr };
    const k = 0.7 * S.smooth / 100;
    if (act.sm) { act.sm.x += (w.x - act.sm.x) * (1 - k); act.sm.y += (w.y - act.sm.y) * (1 - k); }
    else act.sm = { x: w.x, y: w.y };
    w = { x: act.sm.x, y: act.sm.y };
  }
  const p = st.p, n = p.length;
  if (n && Math.hypot(w.x - p[n - 3], w.y - p[n - 2]) * S.view.s < 0.8) return;
  p.push(w.x, w.y, pr);
}

/* ---------- 手ぶれ補正（ペンを離したとき） ----------
   線に沿った近くの点どうしをならす（ガウスの重み）。両端は動かさない。
   向きがはっきり変わる角（「く」「L」の角など）は、そこで区切ってならすので丸くならない */
function smoothStroke(p, sigma) {
  const n = p.length / 3;
  if (n < 5 || !(sigma > 0)) return p;
  const s = new Float64Array(n); // 始点からの道のり
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 1] - p[i * 3 - 2]);
  if (s[n - 1] < sigma * 3) return p; // 点や、とても短い線はそのまま
  // 角を探す：前後に 2σ 離れた点への向きが 75° 以上変わる所（続いていれば、いちばん鋭い所）
  const ang = new Float64Array(n), reach = sigma * 2;
  for (let i = 1, j = 0, k = 1; i < n - 1; i++) {
    while (j < i && s[i] - s[j + 1] >= reach) j++;
    if (k < i) k = i;
    while (k < n - 1 && s[k] - s[i] < reach) k++;
    const ax = p[i * 3] - p[j * 3], ay = p[i * 3 + 1] - p[j * 3 + 1], bx = p[k * 3] - p[i * 3], by = p[k * 3 + 1] - p[i * 3 + 1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la > 1e-9 && lb > 1e-9) ang[i] = Math.acos(clamp((ax * bx + ay * by) / (la * lb), -1, 1));
  }
  const cuts = [0], LIMIT = 75 * Math.PI / 180;
  for (let i = 1; i < n - 1; i++) {
    if (ang[i] < LIMIT) continue;
    let m = i;
    while (i + 1 < n - 1 && ang[i + 1] >= LIMIT) { i++; if (ang[i] > ang[m]) m = i; }
    cuts.push(m);
  }
  cuts.push(n - 1);
  const out = p.slice();
  for (let c = 0; c + 1 < cuts.length; c++) {
    const a = cuts[c], b = cuts[c + 1];
    for (let i = a + 1, lo = a, hi = a; i < b; i++) {
      // 区間の端に近いほど弱く（端の位置がずれないように）
      const sg = Math.min(sigma, s[i] - s[a], s[b] - s[i]);
      if (sg < 1e-6) continue;
      const win = sg * 3; // 前後この道のりの中の点でならす（σ は場所で変わるので、窓は両方向に合わせ直す）
      while (lo < i && s[i] - s[lo] > win) lo++;
      while (lo > a && s[i] - s[lo - 1] <= win) lo--;
      if (hi < i) hi = i;
      while (hi < b && s[hi + 1] - s[i] <= win) hi++;
      while (hi > i && s[hi] - s[i] > win) hi--;
      let wx = 0, wy = 0, ws = 0;
      for (let j = lo; j <= hi; j++) {
        const d = (s[j] - s[i]) / sg, wt = Math.exp(-0.5 * d * d);
        wx += p[j * 3] * wt; wy += p[j * 3 + 1] * wt; ws += wt;
      }
      out[i * 3] = wx / ws; out[i * 3 + 1] = wy / ws;
    }
  }
  return out;
}
function finishSmooth(a) {
  const p = a.st.p;
  // 遅れて追いかけていた分、最後は実際のペン先まで線を伸ばす
  if (a.raw) {
    const n = p.length;
    if (Math.hypot(a.raw.x - p[n - 3], a.raw.y - p[n - 2]) * S.view.s >= 0.8) p.push(a.raw.x, a.raw.y, a.raw.pr);
  }
  a.st.p = smoothStroke(p, 6 * S.smooth / 100 / S.view.s); // 強さ 100 で、画面上 6px くらいの揺れまでならす
}

function onMove(e) {
  if (e.pointerType !== 'touch') {
    hover = { x: e.clientX, y: e.clientY };
    if (S.tool === 'eraser') renderOverSoon();
    if (!act && S.tool === 'lasso') {
      const h = handleAt(e.clientX, e.clientY, e.pointerType);
      over.style.cursor = rotHandleAt(e.clientX, e.clientY, e.pointerType) ? 'grab' : h ? h.cur : '';
      over.classList.toggle('c-move', !h && inSelection(e.clientX, e.clientY));
    }
  }
  const pt = ptrs.get(e.pointerId);
  if (!pt) return;
  const dx = e.clientX - pt.x, dy = e.clientY - pt.y;
  pt.x = e.clientX; pt.y = e.clientY;
  if (!act) return;
  if (act.type === 'pinch' || act.type === 'ruler-pinch') { updatePinch(); return; }
  if (e.pointerId !== act.pid) return;

  let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (!evs.length) evs = [e];

  // ペン：触れるまで待っていた → 筆圧が出たら始める
  if (act.type === 'penwait') {
    const ev = evs.find(v => penTouching(v));
    if (ev) { act = null; startAction(ev); }
    return;
  }
  // ペン：消す・囲む・動かす途中で浮いた（筆圧が 0 近くが続いた）→ そこで終える
  if (e.pointerType === 'pen' && act.type !== 'draw' && /^(erase|lasso|move|scale|rotate)$/.test(act.type)) {
    if (!penTouching(e, true)) { if ((act.low = (act.low || 0) + 1) >= 3) liftPen(e); return; }
    act.low = 0;
  }

  switch (act.type) {
    case 'draw':
      for (const ev of evs) {
        // ペンが浮いた点は使わない。3回続いたら、そこで線を終える
        if (e.pointerType === 'pen' && !penTouching(ev, true)) {
          if ((act.low = (act.low || 0) + 1) >= 3) { liftPen(e); renderOverSoon(); return; }
          continue;
        }
        act.low = 0;
        addPoint(ev);
      }
      renderOverSoon();
      break;
    case 'erase':
      for (const ev of evs) eraseTo(ev.clientX, ev.clientY);
      hover = { x: e.clientX, y: e.clientY };
      renderOverSoon();
      break;
    case 'lasso': {
      const w = toWorld(e.clientX, e.clientY), l = S.lasso[S.lasso.length - 1];
      if (Math.hypot(w.x - l.x, w.y - l.y) * S.view.s > 3) S.lasso.push(w);
      renderOverSoon();
      break;
    }
    case 'move': {
      const w = toWorld(e.clientX, e.clientY);
      S.sel.dx = w.x - act.sx; S.sel.dy = w.y - act.sy;
      render();
      break;
    }
    case 'scale': updateScale(e); break;
    case 'rotate': updateRotate(e); break;
    case 'pan':
      S.view = { ...S.view, x: S.view.x + dx, y: S.view.y + dy };
      viewChanged();
      break;
    case 'ruler-move':
      moveRulerTo(act.gx + e.clientX / S.view.s, act.gy + e.clientY / S.view.s);
      renderOverSoon();
      break;
    case 'ruler-rot': {
      const o = rulerOrigin();
      setRulerAngle(Math.atan2(e.clientY - o.y, e.clientX - o.x) - act.off);
      renderOverSoon();
      break;
    }
  }
}

function onUp(e) {
  ptrs.delete(e.pointerId);
  if (!act) return;
  if (act.type === 'pinch' || act.type === 'ruler-pinch') {
    if (act.ids.includes(e.pointerId)) {
      // 指を1本離しても、全部離すまで何もしない（誤描画防止）
      act = touchList().length ? { type: 'block' } : null;
    }
    return;
  }
  if (act.type === 'block') { if (!touchList().length) act = null; return; }
  if (e.pointerId !== act.pid) return;

  const a = act;
  act = null;
  endAction(a, e);
}

// 操作を終える（ペンを離したとき・ペンが浮いたとき）
function endAction(a, e) {
  switch (a.type) {
    case 'draw':
      S.cur = null;
      if (a.st.p.length) {
        if (!a.snap && !a.curve && S.smooth > 0) finishSmooth(a);
        const before = S.strokes.slice();
        S.strokes.push(a.st);
        pushUndo(before, a.st);
      }
      break;
    case 'erase':
      if (a.changed) pushUndo(a.before);
      if (e.pointerType === 'touch') hover = null;
      break;
    case 'lasso': {
      const poly = S.lasso;
      S.lasso = null;
      if (poly.length > 2) selectByLasso(poly);
      else { const img = imageAt(poly[0]); setSelection(img ? groupWithInk(img) : null); } // 画像をタップ → その PDF 全体と、上に書いた線を選ぶ
      break;
    }
    case 'move': commitMove(); break;
    case 'scale': commitScale(); break;
    case 'rotate': commitRotate(); break;
  }
  setCursor();
  render();
}

over.addEventListener('pointerdown', onDown);
over.addEventListener('pointermove', onMove);
over.addEventListener('pointerup', onUp);
over.addEventListener('pointercancel', onUp);
over.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && !act) { hover = null; renderOverSoon(); } });
over.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());

over.addEventListener('wheel', e => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
  const dx = e.deltaX * k, dy = e.deltaY * k;
  if (S.ruler.on && !e.ctrlKey && rulerHit(e.clientX, e.clientY)) {
    const step = (e.shiftKey ? 15 : 1) * Math.PI / 180;
    setRulerAngle(S.ruler.a + Math.sign(dy || dx) * step, false);
    renderOverSoon();
    return;
  }
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.01));
  else {
    const sx = e.shiftKey && !dx ? dy : dx, sy = e.shiftKey && !dx ? 0 : dy;
    S.view = { ...S.view, x: S.view.x - sx, y: S.view.y - sy };
    viewChanged();
  }
}, { passive: false });

/* =========================================================
   キーボード
   ========================================================= */
const typing = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
document.addEventListener('keydown', e => {
  if (typing() || locked()) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === '0') { e.preventDefault(); resetZoom(); return; }
  if (mod && k === 'd' && S.sel) { e.preventDefault(); duplicateSelection(); return; }
  if (mod) return;
  if (e.key === ' ' && !spaceDown) { spaceDown = true; setCursor(); e.preventDefault(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); return; }
  if (e.key === 'Escape') { closePops(); closeDrawer(); setSelection(null); return; }
  const map = { p: 'pen', m: 'hl', e: 'eraser', l: 'lasso', h: 'hand' };
  if (map[k]) setTool(map[k]);
  if (k === 'r') toggleRuler();
});
document.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; setCursor(); } });

function setCursor() {
  over.className = '';
  over.style.cursor = '';
  if (act && act.type === 'pan') over.classList.add('c-grabbing');
  else if (spaceDown || S.tool === 'hand') over.classList.add('c-grab');
  else if (S.tool === 'eraser') over.classList.add('c-none');
}

/* =========================================================
   UI
   ========================================================= */
const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  lasso: '<path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><circle cx="5" cy="16" r="2"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
  ruler: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  'folder-plus': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 10.5v5M9.5 13h5"/>',
  'folder-move': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 13h6M12.5 10.5 15 13l-2.5 2.5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  shapes: '<path d="M8.3 10a.7.7 0 0 1-.6-1L11.4 3a.7.7 0 0 1 1.2 0L16.3 9a.7.7 0 0 1-.6 1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
function fillIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }

function setTool(t) {
  if (act) cancelAction();
  S.tool = t;
  if (t !== 'lasso') S.sel = null;
  $$('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  renderOptions();
  setCursor();
  renderOverSoon();
}
function swatchHTML(colors, current, attr = 'data-color') {
  const isCustom = !colors.includes(current);
  return colors.map(c => `<button class="sw ${c === current ? 'active' : ''}" ${attr}="${c}" title="${c}"><i style="background:${inkColor(c)}"></i></button>`).join('')
    + `<label class="sw custom ${isCustom ? 'active' : ''}" title="色を選ぶ"><i ${isCustom ? `style="background:${inkColor(current)}"` : ''}></i><input type="color" value="${isCustom ? current : '#000000'}"></label>`;
}

function renderOptions() {
  const box = $('#options');
  const t = S.tool;
  if (t === 'pen' || t === 'hl') {
    const cfg = t === 'pen' ? S.pen : S.hl;
    const colors = t === 'pen' ? PEN_COLORS : HL_COLORS;
    const widths = t === 'pen' ? PEN_WIDTHS : HL_WIDTHS;
    const maxW = widths[widths.length - 1];
    box.innerHTML = `<div class="swatches">${swatchHTML(colors, cfg.color)}</div><span class="sep"></span>`
      + widths.map(w => {
        const d = Math.round(4 + (w / maxW) * 14);
        return `<button class="wd ${w === cfg.width ? 'active' : ''}" data-width="${w}" title="太さ ${w}"><i style="width:${d}px;height:${d}px"></i></button>`;
      }).join('')
      + sizeSliderHTML(cfg.width, SIZE_RANGE[t])
      + `<span class="sep"></span><label class="fld" title="手ぶれ補正：線の波打ちをならします（0 で補正なし）">補正<input type="range" id="smooth" class="smslider" min="0" max="100" step="5" value="${S.smooth}"></label><span class="wval" id="smooth-val">${S.smooth}</span>`
      + (t === 'pen'
        ? `<span class="sep"></span><button class="toggle ${S.pen.pressure !== false ? 'active' : ''}" id="pen-pr" title="ペン（Surface ペン、Apple Pencil など）の筆圧で太さを変える">筆圧 ${S.pen.pressure !== false ? 'オン' : 'オフ'}</button>`
        : '');
    const pr = box.querySelector('#pen-pr');
    if (pr) pr.onclick = () => { S.pen.pressure = S.pen.pressure === false; saveToolPrefs(); renderOptions(); };
    box.querySelectorAll('[data-color]').forEach(b => b.onclick = () => { cfg.color = b.dataset.color; saveToolPrefs(); renderOptions(); });
    box.querySelector('input[type=color]').oninput = e => { cfg.color = e.target.value; saveToolPrefs(); };
    box.querySelector('input[type=color]').onchange = () => renderOptions();
    box.querySelectorAll('[data-width]').forEach(b => b.onclick = () => { cfg.width = +b.dataset.width; saveToolPrefs(); renderOptions(); });
    bindSizeSlider(box, SIZE_RANGE[t], v => { cfg.width = v; });
    const sm = box.querySelector('#smooth');
    sm.oninput = () => { S.smooth = +sm.value; box.querySelector('#smooth-val').textContent = S.smooth; };
    sm.onchange = () => LS.set('smooth', S.smooth);
  } else if (t === 'eraser') {
    const er = S.eraser;
    box.innerHTML = `<div class="seg" id="er-mode"><button data-v="object" class="${er.mode === 'object' ? 'active' : ''}">オブジェクト</button><button data-v="partial" class="${er.mode === 'partial' ? 'active' : ''}">部分</button></div><span class="sep"></span>`
      + ERASER_SIZES.map(s => `<button class="wd ${s === er.size ? 'active' : ''}" data-size="${s}" title="大きさ ${s}"><i style="width:${s / 2 + 4}px;height:${s / 2 + 4}px;background:none;border:1.5px solid currentColor"></i></button>`).join('')
      + sizeSliderHTML(er.size, SIZE_RANGE.eraser);
    box.querySelectorAll('#er-mode button').forEach(b => b.onclick = () => { er.mode = b.dataset.v; saveToolPrefs(); renderOptions(); });
    box.querySelectorAll('[data-size]').forEach(b => b.onclick = () => { er.size = +b.dataset.size; saveToolPrefs(); renderOptions(); });
    bindSizeSlider(box, SIZE_RANGE.eraser, v => { er.size = v; renderOverSoon(); });
  } else box.innerHTML = '';
}

/* ---------- 太さのスライダー ----------
   細い線ほど細かく選べるように、目盛りは等間隔ではなく倍率（対数）で並べる */
const SIZE_RANGE = { pen: [0.5, 30], hl: [4, 60], eraser: [4, 80] };
const toSlider = (v, [a, b]) => Math.round(Math.log(v / a) / Math.log(b / a) * 1000);
const fromSlider = (s, [a, b]) => {
  const v = a * Math.pow(b / a, s / 1000);
  return v < 10 ? Math.round(v * 10) / 10 : Math.round(v * 2) / 2;
};
const fmtSize = v => String(+v.toFixed(1));
function sizeSliderHTML(v, range) {
  return `<span class="sep"></span><input type="range" class="wslider" min="0" max="1000" value="${toSlider(clamp(v, range[0], range[1]), range)}" aria-label="太さ"><span class="wval">${fmtSize(v)}</span>`;
}
function bindSizeSlider(box, range, set) {
  const sl = box.querySelector('.wslider'), lab = box.querySelector('.wval');
  sl.oninput = () => {
    const v = fromSlider(+sl.value, range);
    set(v);
    lab.textContent = fmtSize(v);
    box.querySelectorAll('.wd').forEach(b => b.classList.toggle('active', +(b.dataset.width || b.dataset.size) === v));
  };
  sl.onchange = saveToolPrefs;
}
function saveToolPrefs() { LS.set('pen', S.pen); LS.set('hl', S.hl); LS.set('eraser', S.eraser); }

function renderSelColors() {
  const box = $('#sel-colors');
  box.innerHTML = PEN_COLORS.map(c => `<button class="sw" data-color="${c}" title="${c}"><i style="background:${inkColor(c)}"></i></button>`).join('');
  box.querySelectorAll('[data-color]').forEach(b => b.onclick = () => recolorSelection(b.dataset.color));
  // 画像を選んでいるときは「クラウドに保存するか」の切り替え
  const imgs = S.sel ? [...S.sel.set].filter(isImg) : [], cb = $('#sel-cloud');
  $('#sel-tpl').hidden = !S.sel || imgs.length === S.sel.set.size; // 画像だけのときはテンプレートにできない
  cb.hidden = !imgs.length || !window.FIREBASE_CONFIG;
  if (!cb.hidden) {
    const on = imgs.some(st => !st.nc);
    cb.className = 'toggle' + (on ? ' active' : '');
    cb.innerHTML = icon('cloud') + `<span>${on ? 'クラウドに保存' : 'この端末だけ'}</span>`;
    cb.querySelector('svg').style.cssText = 'width:16px;height:16px';
    cb.title = on ? '押すと「この端末だけ」にします（クラウドのコピーは消して容量を空けます）' : '押すとクラウドにも保存します（ほかの端末でも見られます）';
    cb.onclick = () => setSelectionCloud(!on);
  }
}
// 選んだ画像をクラウドに保存するか切り替える（実際に送る・消すのは同期のとき）
function setSelectionCloud(on) {
  if (!S.sel) return;
  mapSelection(st => (isImg(st) ? { ...st, nc: !on } : st));
  toast(on ? 'クラウドにも保存します' : 'この端末だけに保存します（クラウドのコピーは消します）');
}

/* ---------- 確認用の小さな画面 ---------- */
function askChoice(title, msg, buttons) {
  return new Promise(resolve => {
    const d = $('#dlg');
    d.querySelector('.dlg-title').textContent = title;
    d.querySelector('.dlg-msg').textContent = msg;
    const btns = d.querySelector('.dlg-btns');
    btns.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.primary) el.className = 'primary';
      el.onclick = () => { d.hidden = true; resolve(b.value); };
      btns.appendChild(el);
    }
    d.hidden = false;
    btns.lastElementChild.focus();
  });
}

/* ---------- ポップオーバー ---------- */
function openPop(pop, btn) {
  const wasOpen = !pop.hidden;
  closePops();
  if (wasOpen) return;
  pop.hidden = false;
  const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = clamp(r.left + r.width / 2 - pw / 2, 10, W - pw - 10);
  const top = r.top > H / 2 ? r.top - ph - 10 : r.bottom + 10;
  pop.style.left = left + 'px';
  pop.style.top = clamp(top, 10, H - ph - 10) + 'px';
}
function closePops() { $$('.pop').forEach(p => p.hidden = true); }
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.pop') && !e.target.closest('#btn-bg') && !e.target.closest('#btn-more') && !e.target.closest('#sync') && !e.target.closest('.pop-trigger')) closePops();
}, true);

function syncSeg(el, value) { el.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === String(value))); }
function syncBgUI() {
  syncSeg($('#bg-type'), S.board.bg.type); syncSeg($('#bg-size'), S.board.bg.size);
  $('#bg-strength').value = Math.round((S.board.bg.strength ?? BG_STRENGTH) * 100);
}
// 濃さ：動かしている間は表示だけ、離したら保存
$('#bg-strength').addEventListener('input', e => {
  S.board.bg = { ...S.board.bg, strength: +e.target.value / 100 }; clearTiles(); renderMainSoon();
});
$('#bg-strength').addEventListener('change', () => { LS.set('lastBg', S.board.bg); changed(); });

$('#bg-type').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.board.bg = { ...S.board.bg, type: b.dataset.v }; syncBgUI(); LS.set('lastBg', S.board.bg); changed();
});
$('#bg-size').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.board.bg = { ...S.board.bg, size: +b.dataset.v }; syncBgUI(); LS.set('lastBg', S.board.bg); changed();
});
$('#finger').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.finger = b.dataset.v; LS.set('finger', S.finger); syncSeg($('#finger'), S.finger);
});
/* ---------- ペンの調整 ----------
   ① ペンを浮かせたまま動かしたときに出る筆圧（触れていないのに出る分）と、
   ② 軽く書いたときの弱い筆圧 を測り、その間を「触れた」とみなす強さにする */
const PC_MAX = 0.4; // メーターの右端（40%）
let pcPhase = null; // null | 'hover' | 'write'
const pcSamples = { hover: [], write: [] };
const pct = v => Math.round(v * 1000) / 10 + '%';
function pcMsg(s) { $('#pencal-msg').textContent = s; }
function pcShowNow() {
  $('#pencal-now').textContent = Math.round(S.penMin * 100) + '%';
  $('#pencal-th').style.left = Math.min(100, S.penMin / PC_MAX * 100) + '%';
}
function openPenCal() {
  pcPhase = null;
  pcMsg('下の枠の上でペンを動かすと、今の筆圧がメーターに出ます（赤い線が「触れた」とみなす強さ）。\n「自動で合わせる」を押すと、あなたのペンに合わせて決めます。');
  pcShowNow();
  $('#pencal-fill').style.width = '0';
  $('#pencal-state').textContent = '枠の上でペンを動かしてください';
  $('#pencal').hidden = false;
}
function pcSample(e) {
  if (e.pointerType !== 'pen') { $('#pencal-state').textContent = 'ペンで試してください'; return; }
  for (const ev of (e.getCoalescedEvents && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e])) {
    const down = (ev.buttons & 1) !== 0, pr = down ? ev.pressure : 0, on = down && pr >= S.penMin;
    const fill = $('#pencal-fill');
    fill.style.width = Math.min(100, pr / PC_MAX * 100) + '%';
    fill.className = on ? 'on' : '';
    $('#pencal-state').textContent = !down ? '浮いています（反応なし）'
      : on ? `触れています（筆圧 ${pct(pr)}）` : `近づいています（筆圧 ${pct(pr)}・書かれません）`;
    if (down && pcPhase) pcSamples[pcPhase].push(pr);
  }
}
const pad = $('#pencal-pad');
pad.addEventListener('pointerdown', e => { try { pad.setPointerCapture(e.pointerId); } catch {} e.preventDefault(); pcSample(e); });
pad.addEventListener('pointermove', e => { e.preventDefault(); pcSample(e); });
pad.addEventListener('pointerup', e => pcSample(e));
pad.addEventListener('pointerleave', () => { $('#pencal-fill').style.width = '0'; });
$('#pencal-close').onclick = () => { pcPhase = null; $('#pencal').hidden = true; };

const countdown = (sec, text) => new Promise(res => {
  let left = sec;
  const tick = () => { pcMsg(`${text}（あと ${left} 秒）`); if (left-- <= 0) { clearInterval(t); res(); } };
  const t = setInterval(tick, 1000); tick();
});
$('#pencal-auto').onclick = async () => {
  const btn = $('#pencal-auto');
  btn.disabled = true;
  pcSamples.hover = []; pcSamples.write = [];
  pad.classList.add('measuring');
  try {
    pcPhase = 'hover';
    await countdown(4, '① ペン先を画面に「付けずに」、枠の上でぎりぎりまで近づけて、ゆっくり動かしてください');
    pcPhase = 'write';
    await countdown(5, '② 次に、枠の中に「いつもより軽め」に線を何本か書いてください');
    pcPhase = null;
    const w = pcSamples.write.slice().sort((a, b) => a - b);
    if (w.length < 10) { pcMsg('② で線が書かれませんでした。もう一度「自動で合わせる」を押してください。'); return; }
    const hoverMax = pcSamples.hover.reduce((m, v) => Math.max(m, v), 0);
    // 軽く書いたときの弱い方（下から 10%）。浮かせたときの値は混ざらないよう、それより上だけで見る
    const above = w.filter(v => v > hoverMax);
    const light = above.length >= 10 ? above[Math.floor(above.length * 0.1)] : 0;
    let th, note;
    if (light > hoverMax + 0.01) {
      th = (hoverMax + light) / 2;
      note = `浮かせたとき 最大 ${pct(hoverMax)}・軽く書いたとき ${pct(light)} くらい → 間の ${Math.round(clamp(th, 0.01, 0.3) * 100)}% にしました。`;
    } else {
      th = hoverMax + 0.01;
      note = `浮かせたとき（最大 ${pct(hoverMax)}）と軽く書いたときの筆圧が近く、きれいに分けられませんでした。${Math.round(clamp(th, 0.01, 0.3) * 100)}% にしたので、軽い線が途切れるときは少し強めに書くか、メニューで下げてください。`;
    }
    S.penMin = Math.round(clamp(th, 0.01, 0.3) * 100) / 100;
    LS.set('penMin', S.penMin);
    syncPenMin(); pcShowNow();
    pcMsg('合わせました。' + note + '\n枠の上で試して、よければ「閉じる」を押してください。');
  } finally {
    pcPhase = null;
    btn.disabled = false;
    pad.classList.remove('measuring');
  }
};

// ペンが触れたとみなす強さ（%）
function syncPenMin() { $('#penmin').value = Math.round(S.penMin * 100); $('#penmin-val').textContent = Math.round(S.penMin * 100) + '%'; }
$('#penmin').addEventListener('input', e => { S.penMin = +e.target.value / 100; syncPenMin(); });
$('#penmin').addEventListener('change', () => LS.set('penMin', S.penMin));
syncPenMin();
$('#theme').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.theme = b.dataset.v; LS.set('theme', S.theme); applyTheme();
});

/* ---------- テーマ ---------- */
const mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function applyTheme() {
  const dark = S.theme === 'dark' || (S.theme === 'auto' && !!mqDark && mqDark.matches);
  clearTiles();
  T = dark ? THEMES.dark : THEMES.light;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]').content = dark ? '#1b1c20' : '#f6f7f9';
  syncSeg($('#theme'), S.theme);
  renderOptions();
  if (S.sel) renderSelColors();
  render();
}
if (mqDark) mqDark.addEventListener('change', () => { if (S.theme === 'auto') applyTheme(); });

$('#pop-more').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  closePops();
  ({ fit: fitAll, png: exportPNG, export: exportJSON, import: () => $('#file-import').click(), pencal: openPenCal })[b.dataset.act]();
});

$$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#btn-ruler').onclick = toggleRuler;
$('#btn-undo').onclick = undo;
$('#btn-redo').onclick = redo;
$('#btn-bg').onclick = e => openPop($('#pop-bg'), e.currentTarget);
$('#btn-more').onclick = e => openPop($('#pop-more'), e.currentTarget);
$('#zoom').onclick = resetZoom;
$('#sel-del').onclick = deleteSelection;
$('#sel-dup').onclick = duplicateSelection;
$('#sel-tpl').onclick = saveSelectionAsTemplate;
$('#btn-tpl').onclick = e => { renderTemplates(); openPop($('#pop-tpl'), e.currentTarget); };

/* ---------- 表示 ---------- */
function resetZoom() { zoomAt(W / 2, H / 2, 1 / S.view.s); }
function contentBox(strokes) {
  if (!strokes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of strokes) {
    const b = bbox(st);
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return { x0, y0, x1, y1 };
}
function fitAll() {
  const b = contentBox(S.strokes);
  if (!b) { S.view = { x: 0, y: 0, s: 1 }; viewChanged(); return; }
  const s = clamp(Math.min((W - 80) / (b.x1 - b.x0), (H - 200) / (b.y1 - b.y0)), 0.05, 2);
  S.view = { s, x: W / 2 - (b.x0 + b.x1) / 2 * s, y: H / 2 - (b.y0 + b.y1) / 2 * s };
  viewChanged();
}

/* ---------- 書き出し・読み込み ---------- */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const safeName = s => (s || 'board').replace(/[\\/:*?"<>|]/g, '_');

async function exportPNG() {
  // 範囲を選択しているときは、その選択範囲だけを書き出す
  const strokes = S.sel ? S.strokes.filter(st => S.sel.set.has(st)) : S.strokes;
  const b = contentBox(strokes);
  if (!b) { toast('まだ何も描かれていません'); return; }
  await Promise.all(strokes.filter(isImg).map(st => loadBitmap(st.a))); // 画像を読み込み終えてから
  const pad = 40;
  let scale = 2;
  const bw = b.x1 - b.x0 + pad * 2, bh = b.y1 - b.y0 + pad * 2;
  scale = Math.min(scale, 8000 / bw, 8000 / bh);
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(bw * scale); cv.height = Math.ceil(bh * scale);
  const c = cv.getContext('2d');
  const L = THEMES.light; // 書き出しはいつも白い紙
  c.fillStyle = L.paper; c.fillRect(0, 0, cv.width, cv.height);
  c.setTransform(scale, 0, 0, scale, -(b.x0 - pad) * scale, -(b.y0 - pad) * scale);
  drawBg(c, { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }, scale, S.board.bg, L);
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const st of strokes) drawStroke(c, st, L);
  cv.toBlob(blob => download(blob, safeName(S.board.name) + '.png'), 'image/png');
}

async function exportJSON() {
  saveNow();
  // メモリ上の最新の内容を書き出す（保存の書き込み待ちがあっても漏れないように）
  const boards = visibleBoards().map(b => (b === S.board ? { ...b, strokes: S.strokes, view: { ...S.view } } : b));
  // 取り込んだ画像も一緒に（base64 の文字列にして入れる）
  const assets = {};
  for (const b of boards) for (const st of b.strokes || []) {
    if (!isImg(st) || assets[st.a]) continue;
    const rec = await Store.getAsset(st.a);
    if (rec) assets[st.a] = { mime: rec.mime, w: rec.w, h: rec.h, data: await blobToBase64(rec.blob) };
  }
  const data = { app: 'canvas-note', version: 1, exportedAt: new Date().toISOString(), boards, assets };
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `canvas-note-${stamp}.json`);
}

$('#file-import').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.boards)) throw new Error('形式が違います');
    if (!confirm(`${data.boards.length} 個のボードを読み込みます。同じボードがあれば上書きされます。よろしいですか？`)) return;
    saveNow();
    for (const [id, a] of Object.entries(data.assets || {})) {
      await Store.putAsset({ id, mime: a.mime, w: a.w, h: a.h, blob: base64ToBlob(a.data, a.mime), up: false });
    }
    for (const b of data.boards) {
      if (!b || !b.id || b.deleted || !Array.isArray(b.strokes)) continue;
      delete b.syncedAt;           // 読み込んだものはクラウドにも送り直す
      b.updatedAt = Date.now();
      await Store.put(b);
    }
    await loadBoards();
    window.Sync?.changed();
    toast('読み込みました');
  } catch (err) { toast('読み込めませんでした: ' + err.message); }
});

/* =========================================================
   画像・PDF の取り込み
   画像は長い辺 2400px まで、PDF は1ページずつ幅 1400px の画像にして保存する。
   取り込んだものは線の下に置き、選んだ状態にする（そのまま動かす・大きさを変えられる）
   ========================================================= */
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.4.299/';
let pdfjsP = null;
const loadPdfJs = () => (pdfjsP = pdfjsP || import(PDFJS + 'pdf.min.mjs').then(m => {
  m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
  return m;
}).catch(err => { pdfjsP = null; throw err; }));

const blobToBase64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});
function base64ToBlob(b64, mime) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: mime });
}
const canvasBlob = (cv, mime, q) => new Promise(r => cv.toBlob(r, mime, q));
// 透明な部分があるか（小さく縮めて調べる）
function hasAlpha(bm) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 48;
  const c = cv.getContext('2d'); c.drawImage(bm, 0, 0, 48, 48);
  const d = c.getImageData(0, 0, 48, 48).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}
async function saveAsset(blob, mime, w, h) {
  const id = uid();
  await Store.putAsset({ id, blob, mime, w, h, up: false });
  return { id, w, h };
}
async function imageToAsset(file) {
  const bm = await createImageBitmap(file);
  const k = Math.min(1, 2400 / Math.max(bm.width, bm.height));
  const w = Math.max(1, Math.round(bm.width * k)), h = Math.max(1, Math.round(bm.height * k));
  // 小さくて扱える形式ならそのまま、そうでなければ縮めて保存し直す
  if (k === 1 && /^image\/(jpeg|png|webp)$/.test(file.type) && file.size < 1.5e6) { bm.close(); return saveAsset(file, file.type, w, h); }
  const alpha = file.type !== 'image/jpeg' && hasAlpha(bm);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  if (!alpha) { c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); }
  c.imageSmoothingQuality = 'high';
  c.drawImage(bm, 0, 0, w, h);
  bm.close();
  const mime = alpha ? 'image/png' : 'image/jpeg';
  return saveAsset(await canvasBlob(cv, mime, 0.85), mime, w, h);
}
async function pdfToAssets(file, onPage) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const out = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onPage(i, doc.numPages);
      const page = await doc.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(1400 / v1.width, 2000 / v1.height) });
      const cv = document.createElement('canvas');
      cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
      const c = cv.getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: c, canvas: cv, viewport: vp }).promise;
      out.push(await saveAsset(await canvasBlob(cv, 'image/jpeg', 0.85), 'image/jpeg', cv.width, cv.height));
      page.cleanup();
      cv.width = cv.height = 0;
    }
  } finally { await task.destroy(); } // 読み込みの後片付け（PDF の作業用スレッドも止まる）
  return out;
}

let importing = false;
async function importFiles(files, at) {
  const list = [...files].filter(f => /^image\//.test(f.type) || f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!list.length) { toast('画像か PDF を選んでください'); return; }
  if (importing) { toast('取り込み中です'); return; }
  importing = true;
  try {
    // ファイルごとのまとまり（PDF は全ページで1つ。g が同じものは一緒に選ばれる）
    const groups = [];
    for (const f of list) {
      const pdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      try {
        const assets = pdf
          ? await pdfToAssets(f, (i, n) => toast(`PDF を読み込み中… ${i} / ${n} ページ`))
          : (toast('画像を読み込み中…'), [await imageToAsset(f)]);
        groups.push({ name: f.name, pdf, assets, g: uid(), nc: false });
      } catch (err) {
        console.error(err);
        toast(`「${f.name}」を読み込めませんでした（${err.message}）`);
      }
    }
    if (!groups.length) return;
    // クラウドにも保存するか（ログイン中だけ聞く。PDF はファイルごと、画像はまとめて1回）
    if (syncState.user) {
      const cloudMB = async gs => {
        let n = 0;
        for (const gr of gs) for (const a of gr.assets) { const r = await Store.getAsset(a.id); n += r ? r.blob.size : 0; }
        return (n * 4 / 3 / 1e6).toFixed(1); // クラウドでは base64 にするので約 4/3 倍
      };
      const note = '\n「この端末だけ」にすると、クラウドの容量を使いません。ほかの端末では灰色の枠になります（上に書いた線は同期されます）。\nあとから、選んだときに出るバーで変えられます。';
      const choices = [{ label: 'この端末だけ', value: false }, { label: 'クラウドにも保存', value: true, primary: true }];
      for (const gr of groups.filter(g => g.pdf)) {
        const on = await askChoice(`「${gr.name}」をクラウドにも保存しますか？`, `${gr.assets.length} ページ・クラウドで約 ${await cloudMB([gr])} MB 使います。` + note, choices);
        gr.nc = !on;
      }
      const imgs = groups.filter(g => !g.pdf);
      if (imgs.length) {
        const title = imgs.length > 1 ? `画像 ${imgs.length} 枚をクラウドにも保存しますか？` : `「${imgs[0].name}」をクラウドにも保存しますか？`;
        const on = await askChoice(title, `クラウドで約 ${await cloudMB(imgs)} MB 使います。` + note, choices);
        for (const gr of imgs) gr.nc = !on;
      }
    }
    const assets = groups.flatMap(gr => gr.assets.map(a => ({ ...a, g: gr.g, nc: gr.nc })));
    // 置き場所：画面の幅の 7 割くらい（最大 720px 分）の大きさで、縦に並べる
    const s = S.view.s, colW = Math.min(W * 0.7, 720) / s, gap = 24 / s;
    const c = at || toWorld(W / 2, H / 2);
    let y = c.y - (colW * assets[0].h / assets[0].w) / 2;
    const items = assets.map(a => {
      const h = colW * a.h / a.w, x0 = c.x - colW / 2;
      const st = { id: uid(), t: 'img', a: a.id, g: a.g, c: '', w: 0, pr: false, p: [x0, y, 0, x0 + colW, y + h, 0] };
      if (a.nc) st.nc = true; // この端末だけ（クラウドに送らない）
      y += h + gap;
      return st;
    });
    // 画像は線の下へ（いちばん下にある画像の続き）
    const before = S.strokes.slice();
    let at0 = 0;
    while (at0 < S.strokes.length && isImg(S.strokes[at0])) at0++;
    S.strokes = [...S.strokes.slice(0, at0), ...items, ...S.strokes.slice(at0)];
    pushUndo(before);
    // そのまま動かしたり大きさを変えたりできるよう、選んだ状態にする
    setTool('lasso');
    setSelection(new Set(items));
    toast(assets.length > 1 ? `${assets.length} 枚取り込みました` : '取り込みました');
  } finally { importing = false; }
}

$('#btn-import').onclick = () => $('#file-media').click();
$('#file-media').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
});
// ファイルをキャンバスに落とす
window.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!e.dataTransfer || !e.dataTransfer.files.length || locked()) return;
  e.preventDefault();
  importFiles(e.dataTransfer.files, toWorld(e.clientX, e.clientY));
});
// 貼り付け（スクリーンショットなど）
document.addEventListener('paste', e => {
  if (typing() || locked() || !e.clipboardData) return;
  const files = [...e.clipboardData.files].filter(f => /^image\//.test(f.type) || f.type === 'application/pdf');
  if (files.length) { e.preventDefault(); importFiles(files); }
});

/* =========================================================
   ボード管理
   削除したボードは、同期済みなら「削除済み」の印を残して他の端末に伝える
   ========================================================= */
const visibleBoards = () => S.boards.filter(b => !b.deleted);
const newest = () => visibleBoards().sort((a, b) => b.updatedAt - a.updatedAt)[0];

function newBoardData(name) {
  const t = Date.now();
  return { id: uid(), name, createdAt: t, updatedAt: t, bg: LS.get('lastBg', { type: 'grid', size: 32 }), view: { x: 0, y: 0, s: 1 }, strokes: [] };
}
async function ensureBoard() {
  if (visibleBoards().length) return;
  const b = newBoardData(S.boards.length ? '新しいボード' : 'はじめてのボード');
  b.auto = true; // 自動で作った空のボード（クラウドにボードがあれば同期のときに片付ける）
  await Store.put(b);
  S.boards.push(b);
}
async function loadBoards() {
  const [boards, pending] = await Promise.all([Store.all(), Store.allPending()]);
  S.boards = boards;
  // 「ここまで同期した」は localStorage の方が新しい（ボード全体の保存より先に書くため）
  for (const b of S.boards) { const s = LS.get('synced:' + b.id, null); if (s != null) b.syncedAt = s; }
  // 前回、ボード全体に書き込む前に閉じた線を戻す
  const touched = new Set();
  for (const { b: id, st } of pending) {
    const b = S.boards.find(x => x.id === id);
    if (!b || b.deleted) continue;
    b.strokes = b.strokes || [];
    if (!b.strokes.some(s => s.id === st.id)) { b.strokes.push(st); b.updatedAt = Math.max(b.updatedAt || 0, Date.now()); touched.add(b); }
  }
  for (const b of touched) await Store.put(b);
  await ensureBoard();
  const last = LS.get('lastBoard', null);
  S.board = null; // 読み込み直後なので、古いメモリ内容で上書き保存しない
  openBoard(visibleBoards().find(b => b.id === last) || newest());
}

function openBoard(b) {
  if (S.board && S.board !== b) saveNow();
  if (act) cancelAction();
  S.board = b;
  S.strokes = b.strokes || [];
  clearTiles();
  const v = LS.get('view:' + b.id, null) || b.view;
  S.view = v && Number.isFinite(v.s) ? { x: v.x, y: v.y, s: v.s } : { x: 0, y: 0, s: 1 };
  snapView();
  if (!b.bg) b.bg = { type: 'grid', size: 32 };
  S.undo = []; S.redo = []; S.sel = null;
  $('#title').value = b.name;
  document.title = b.name + ' – Canvas Note';
  LS.set('lastBoard', b.id);
  syncBgUI();
  updateHistoryButtons();
  renderBoardList();
  render();
}

/* ---------- フォルダ（入れ子にできる） ----------
   ボードの folder に「数学/微分」のような道筋を持つ（/ で区切る）。道筋はボードと一緒に同期される。
   まだ空のフォルダは、この端末の localStorage にだけ覚えておく */
const SEP = '/';
const parentOf = p => (p.includes(SEP) ? p.slice(0, p.lastIndexOf(SEP)) : null);
const leafOf = p => p.slice(p.lastIndexOf(SEP) + 1);
const depthOf = p => p.split(SEP).length - 1;
const inFolder = (f, p) => !!f && (f === p || f.startsWith(p + SEP)); // f が p の中（p 自身も含む）
// 木の順（親のすぐ後に子）に並べる
function byPath(a, b) {
  const A = a.split(SEP), B = b.split(SEP);
  for (let i = 0; i < Math.min(A.length, B.length); i++) { const c = A[i].localeCompare(B[i], 'ja'); if (c) return c; }
  return A.length - B.length;
}
function folderNames() {
  const set = new Set();
  const add = p => { while (p) { set.add(p); p = parentOf(p); } }; // 親のフォルダも
  for (const f of LS.get('folders', [])) add(f);
  for (const b of visibleBoards()) if (b.folder) add(b.folder);
  return [...set].sort(byPath);
}
const childFolders = parent => folderNames().filter(p => parentOf(p) === parent);
const folderOpen = name => LS.get('folderOpen', {})[name] !== false;
function setFolderOpen(name, open) { const o = LS.get('folderOpen', {}); o[name] = open; LS.set('folderOpen', o); }
// 名前を聞いて、parent の中の道筋にする（「/」は区切りに使うので全角に）
function askFolderName(title, parent, current = '') {
  const name = (prompt(title, current) || '').trim().replace(/\//g, '／');
  if (!name) return null;
  const path = parent ? parent + SEP + name : name;
  if (name !== current && folderNames().includes(path)) { toast(`「${name}」はもうあります`); return null; }
  return path;
}
function addFolder(parent = null) {
  const path = askFolderName(parent ? `「${leafOf(parent)}」の中に作るフォルダの名前` : '新しいフォルダの名前', parent);
  if (!path) return null;
  LS.set('folders', [...LS.get('folders', []), path]);
  setFolderOpen(path, true);
  if (parent) setFolderOpen(parent, true);
  renderBoardList();
  return path;
}
// フォルダの道筋を付け替える（中のフォルダ・ボードも一緒に）。map(道筋) → 新しい道筋
function repath(isTarget, map) {
  LS.set('folders', [...new Set(LS.get('folders', []).map(p => (isTarget(p) ? map(p) : p)).filter(Boolean))]);
  const open = LS.get('folderOpen', {}), o2 = {};
  for (const k in open) { const nk = isTarget(k) ? map(k) : k; if (nk) o2[nk] = open[k]; }
  LS.set('folderOpen', o2);
  for (const b of visibleBoards()) if (b.folder && isTarget(b.folder)) updateBoardMeta(b, { folder: map(b.folder) || null });
}
function renameFolder(path) {
  const neu = askFolderName('フォルダの名前', parentOf(path), leafOf(path));
  if (!neu || neu === path) return;
  repath(p => inFolder(p, path), p => neu + p.slice(path.length));
  renderBoardList();
}
function moveFolder(path, dest) { // dest：移動先のフォルダ（null ならいちばん上）
  if (dest && inFolder(dest, path)) { toast('フォルダを自分の中には移せません'); return; }
  const neu = (dest ? dest + SEP : '') + leafOf(path);
  if (neu === path) return;
  if (folderNames().includes(neu)) { toast(`移動先に「${leafOf(path)}」がもうあります`); return; }
  repath(p => inFolder(p, path), p => neu + p.slice(path.length));
  if (dest) setFolderOpen(dest, true);
  renderBoardList();
}
// 削除：中のボードとサブフォルダは消さず、1つ上の階層へ移す
function deleteFolder(path) {
  const parent = parentOf(path);
  const n = visibleBoards().filter(b => inFolder(b.folder, path)).length;
  const subs = folderNames().filter(p => p.startsWith(path + SEP) && parentOf(p) === path).length;
  const dest = parent ? `「${leafOf(parent)}」` : '「フォルダなし」';
  const inside = [n ? `${n} 個のボード` : '', subs ? `${subs} 個のフォルダ` : ''].filter(Boolean).join('と');
  if (!confirm(inside ? `フォルダ「${leafOf(path)}」を削除します。中の${inside}は消さずに${dest}に移します。` : `フォルダ「${leafOf(path)}」を削除します。`)) return;
  repath(p => inFolder(p, path), p => (p === path ? parent : (parent ? parent + SEP : '') + p.slice(path.length + 1)));
  renderBoardList();
}
// ボードの名前・フォルダなどを変えて保存・同期する
function updateBoardMeta(b, patch) {
  Object.assign(b, patch, { updatedAt: Date.now() });
  if (b === S.board) saveNow(); else Store.put(b);
  window.Sync?.changed();
}

/* ---------- フォルダを選ぶメニュー（ボード・フォルダの移動先） ---------- */
// current：今いるフォルダ（印を付ける）、exclude：選べないフォルダ（自分自身とその中）
function openFolderPicker(btn, title, { current, exclude, topLabel, onPick }) {
  const pop = $('#pop-move');
  const list = [null, ...folderNames().filter(p => !(exclude && inFolder(p, exclude)))];
  pop.innerHTML = `<div class="pop-label"></div>`
    + list.map((p, i) => `<button class="mitem ${p === (current || null) ? 'active' : ''}" data-i="${i}" style="padding-left:${10 + (p ? depthOf(p) * 16 : 0)}px"><span data-icon="${p ? 'folder' : 'inbox'}"></span><span></span></button>`).join('')
    + `<hr><button class="mitem" data-new="1"><span data-icon="folder-plus"></span><span>新しいフォルダ…</span></button>`;
  pop.querySelector('.pop-label').textContent = title;
  pop.querySelectorAll('[data-i]').forEach(el => { const p = list[+el.dataset.i]; el.lastElementChild.textContent = p ? leafOf(p) : topLabel; });
  fillIcons(pop);
  pop.onclick = e => {
    const el = e.target.closest('button'); if (!el) return;
    let dest;
    if (el.dataset.new) { dest = addFolder(null); if (!dest) return; }
    else dest = list[+el.dataset.i];
    closePops();
    onPick(dest);
    renderBoardList();
  };
  openPop(pop, btn);
}
function openMoveMenu(b, btn) {
  openFolderPicker(btn, `「${b.name}」の移動先`, {
    current: b.folder || null, topLabel: 'フォルダなし',
    onPick: folder => { if ((b.folder || null) !== folder) { updateBoardMeta(b, { folder }); if (folder) setFolderOpen(folder, true); } },
  });
}
// フォルダの「︙」メニュー
function openFolderMenu(path, btn) {
  const pop = $('#pop-folder');
  const items = [
    ['plus', '新しいボード', () => createBoard(path)],
    ['folder-plus', 'サブフォルダを作る', () => addFolder(path)],
    ['edit', '名前を変更', () => renameFolder(path)],
    ['folder-move', '別のフォルダへ移動', () => openFolderPicker(btn, `「${leafOf(path)}」の移動先`, {
      current: parentOf(path), exclude: path, topLabel: 'いちばん上', onPick: dest => moveFolder(path, dest),
    })],
    ['trash', '削除', () => deleteFolder(path)],
  ];
  pop.innerHTML = `<div class="pop-label"></div>` + items.map(([ic, label], i) => `<button class="mitem${ic === 'trash' ? ' danger' : ''}" data-i="${i}"><span data-icon="${ic}"></span><span>${label}</span></button>`).join('');
  pop.querySelector('.pop-label').textContent = leafOf(path);
  fillIcons(pop);
  pop.onclick = e => {
    const el = e.target.closest('[data-i]'); if (!el) return;
    closePops();
    items[+el.dataset.i][2]();
  };
  openPop(pop, btn);
}
const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderBoardList() {
  const ul = $('#board-list');
  const fmt = t => new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  ul.innerHTML = '';
  const boards = visibleBoards().sort((a, b) => b.updatedAt - a.updatedAt);
  const button = (icon, title) => `<button class="ibtn" data-icon="${icon}" title="${title}"></button>`;
  const INDENT = 16;

  const boardRow = (b, depth) => {
    const li = document.createElement('li');
    li.className = 'board' + (b === S.board ? ' current' : '');
    if (depth) li.style.marginLeft = depth * INDENT + 6 + 'px';
    li.innerHTML = `<div class="meta"><div class="name"></div><div class="date">${fmt(b.updatedAt)}</div></div>`
      + button('folder-move', 'フォルダへ移動') + button('edit', '名前を変更') + button('trash', '削除');
    li.querySelector('.name').textContent = b.name;
    fillIcons(li);
    const [mv, ren, del] = li.querySelectorAll('button');
    mv.classList.add('pop-trigger');
    li.onclick = () => { openBoard(b); closeDrawer(); };
    mv.onclick = e => { e.stopPropagation(); openMoveMenu(b, mv); };
    ren.onclick = e => {
      e.stopPropagation();
      const name = prompt('ボード名', b.name);
      if (name && name.trim()) renameBoard(b, name.trim());
    };
    del.onclick = e => {
      e.stopPropagation();
      if (confirm(`「${b.name}」を削除します。元に戻せません。`)) deleteBoard(b);
    };
    return li;
  };

  const folderRow = path => {
    const depth = depthOf(path), open = folderOpen(path);
    const all = boards.filter(b => inFolder(b.folder, path)); // 中のフォルダの分も数える
    const li = document.createElement('li');
    li.className = 'folder' + (open ? ' open' : '') + (all.includes(S.board) ? ' has-current' : '');
    if (depth) li.style.marginLeft = depth * INDENT + 'px';
    li.innerHTML = `<span class="chev" data-icon="chevron"></span><span class="ficon" data-icon="folder"></span>
      <div class="meta"><div class="name"></div></div><span class="count">${all.length}</span>`
      + button('plus', 'このフォルダに新しいボード') + button('more', 'フォルダの操作');
    li.querySelector('.name').textContent = leafOf(path);
    fillIcons(li);
    const [add, more] = li.querySelectorAll('button');
    more.classList.add('pop-trigger');
    li.onclick = () => { setFolderOpen(path, !open); renderBoardList(); };
    add.onclick = e => { e.stopPropagation(); createBoard(path); };
    more.onclick = e => { e.stopPropagation(); openFolderMenu(path, more); };
    ul.appendChild(li);
    if (!open) return;
    for (const sub of childFolders(path)) folderRow(sub);
    for (const b of boards.filter(b => b.folder === path)) ul.appendChild(boardRow(b, depth + 1));
  };

  const tops = childFolders(null);
  for (const f of tops) folderRow(f);
  const loose = boards.filter(b => !b.folder);
  if (loose.length && tops.length) {
    const h = document.createElement('li');
    h.className = 'section';
    h.textContent = 'フォルダなし';
    ul.appendChild(h);
  }
  for (const b of loose) ul.appendChild(boardRow(b, 0));
}
async function deleteBoard(b) {
  if (b.syncedAt) {
    Object.assign(b, { deleted: true, strokes: [], updatedAt: Date.now() });
    await Store.put(b);
    window.Sync?.changed();
  } else {
    await Store.del(b.id);
    S.boards = S.boards.filter(x => x !== b);
  }
  await ensureBoard();
  if (b === S.board) { S.board = null; openBoard(newest()); } else renderBoardList();
}
function renameBoard(b, name) {
  updateBoardMeta(b, { name });
  if (b === S.board) { $('#title').value = name; document.title = name + ' – Canvas Note'; }
  renderBoardList();
}

$('#title').addEventListener('change', e => {
  const v = e.target.value.trim();
  if (v) renameBoard(S.board, v); else e.target.value = S.board.name;
});
$('#title').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

async function createBoard(folder) {
  saveNow();
  const b = newBoardData('ボード ' + (visibleBoards().length + 1));
  if (folder) { b.folder = folder; setFolderOpen(folder, true); }
  await Store.put(b);
  S.boards.push(b);
  openBoard(b);
  closeDrawer();
}
$('#btn-new').onclick = () => createBoard(null);
$('#btn-new-folder').onclick = () => addFolder();

function openDrawer() { renderBoardList(); renderUsage(); $('#drawer').classList.add('open'); $('#drawer-scrim').hidden = false; }

// クラウドの使用量（無料枠 1GB に対して）。ログインしていなければ出さない
const FREE_BYTES = 1024 ** 3;
function renderUsage() {
  const u = window.Sync && window.Sync.usage ? window.Sync.usage() : null;
  $('#usage').hidden = !u;
  if (!u) return;
  const mb = n => (n < 1e6 ? (n / 1e6).toFixed(2) : n < 1e8 ? (n / 1e6).toFixed(1) : Math.round(n / 1e6)) + ' MB';
  const ratio = u.total / FREE_BYTES, fill = $('#usage-fill');
  $('#usage-total').textContent = `約 ${mb(u.total)} / 1 GB`;
  fill.style.width = Math.min(100, Math.max(ratio * 100, u.total ? 0.5 : 0)) + '%';
  fill.className = ratio > 0.9 ? 'full' : ratio > 0.7 ? 'warn' : '';
  $('#usage-detail').textContent = `ノート ${mb(u.boards)}・画像 ${mb(u.assets)}（${(ratio * 100).toFixed(ratio < 0.1 ? 2 : 1)}%）`;
}
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer-scrim').hidden = true; }
$('#btn-drawer').onclick = openDrawer;
$('#drawer-scrim').onclick = closeDrawer;

/* ---------- トースト ---------- */
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, 2600);
}

/* =========================================================
   クラウド同期との接続（sync.js から使う）
   ========================================================= */
const SYNC_LABEL = { off: '同期オフ', signedout: 'ログイン', local: 'この端末だけ', pending: '未送信', syncing: '同期中…', ok: '同期済み', offline: 'オフライン', error: '同期エラー' };
const syncState = { status: 'off', user: null, msg: '' };

function renderSync() {
  const btn = $('#sync');
  btn.className = 'chip s-' + syncState.status;
  btn.querySelector('.label').textContent = SYNC_LABEL[syncState.status];
  btn.title = syncState.msg || SYNC_LABEL[syncState.status];
  $('#sync-user').textContent = syncState.user || '';
  $('#sync-state').textContent = SYNC_LABEL[syncState.status] + (syncState.msg ? '：' + syncState.msg : '');
}

window.App = {
  boards: () => S.boards,
  getAsset: id => Store.getAsset(id),
  putAsset: rec => Store.putAsset(rec),
  blobToBase64, base64ToBlob,
  strokesOf: b => (b === S.board ? S.strokes : b.strokes || []),
  saveNow,
  persist(b) {
    // 「ここまで同期した」はすぐ覚える（ボード全体の保存を待つ間に閉じても、競合と間違えないように）
    LS.set('synced:' + b.id, b.syncedAt);
    // 今のボードの全体は、手を止めたときのまとめ書きに任せる（書いている最中に全体を書き直さない）
    if (b === S.board) { scheduleSave(COMPACT_MS); return Promise.resolve(); }
    return Store.put(b);
  },
  // クラウドの内容でボードを置き換える。その間に編集が入っていたら見送る（次の同期で処理）
  async applyRemote(data, force) {
    let b = S.boards.find(x => x.id === data.id);
    if (b && !force && b.updatedAt !== b.syncedAt) return;
    if (b) Object.assign(b, data, { deleted: false });
    else { b = { ...data, view: { x: 0, y: 0, s: 1 } }; S.boards.push(b); }
    LS.set('synced:' + b.id, b.syncedAt);
    await Store.put(b);
    if (b === S.board) {
      if (act) cancelAction();
      S.strokes = b.strokes; S.undo = []; S.redo = []; S.sel = null; clearTiles();
      $('#title').value = b.name;
      syncBgUI(); updateHistoryButtons(); render();
    }
    renderBoardList();
  },
  async removeLocal(id) {
    const b = S.boards.find(x => x.id === id);
    await Store.del(id);
    S.boards = S.boards.filter(x => x.id !== id);
    await ensureBoard();
    if (b === S.board) { S.board = null; openBoard(newest()); } else renderBoardList();
  },
  async duplicateAsConflict(src) {
    const t = Date.now();
    const b = {
      id: uid(), name: src.name + '（競合コピー）', createdAt: t - 1, updatedAt: t,
      bg: src.bg, folder: src.folder || null, view: { x: 0, y: 0, s: 1 }, strokes: (src === S.board ? S.strokes : src.strokes || []).slice(),
    };
    await Store.put(b);
    S.boards.push(b);
    renderBoardList();
    toast(`「${src.name}」が両方の端末で編集されていたので、コピーを残しました`);
  },
  setSyncStatus(status, msg = '') { syncState.status = status; syncState.msg = msg; renderSync(); },
  setSyncUser(u) { syncState.user = u; renderSync(); renderUsage(); },
  // ログインの状態が変わった。クラウドに保存してよいアカウントなら true（そのときだけ同期する）
  authChanged(u) {
    setGate(u ? 'ok' : 'out');
    if (u && !isAllowed(u)) toast('このアカウントでは、ノートはこの端末だけに保存します');
    return isAllowed(u);
  },
  usageChanged() { if ($('#drawer').classList.contains('open')) renderUsage(); },
  templates: () => templates,
  // クラウドと突き合わせた結果で置き換える（ここからは Sync に知らせない）
  setTemplates(list) {
    templates = list;
    LS.set('templates', templates);
    if (!$('#pop-tpl').hidden) renderTemplates();
  },
  syncReady() {},
};

/* ---------- ログイン画面：ログインするまでノートを見せない（Firebase を使わない設定なら出さない） ----------
   クラウドに保存するのは ALLOWED_EMAILS（firebase-config.js）のアカウントだけ。空なら誰でも。
   ほかのアカウントはこの端末だけに保存する（本当の守りは Firestore のルール） */
const ALLOWED_EMAILS = (window.ALLOWED_EMAILS || []).map(e => e.toLowerCase());
const isAllowed = u => !!u && u.emailVerified !== false
  && (!ALLOWED_EMAILS.length || ALLOWED_EMAILS.includes((u.email || '').toLowerCase()));
const locked = () => !$('#gate').hidden;
const GATE_MSG = {
  checking: '確認中…',
  out: 'ログインしてください',
  error: 'ログインの準備ができませんでした。ネットにつないでから開き直してください。',
};
function setGate(state, email = '') {
  const m = GATE_MSG[state];
  $('#gate').hidden = state === 'ok';
  $('#gate-msg').textContent = typeof m === 'function' ? m(email) : m || '';
  $('#gate-login').hidden = state !== 'out';
  if (state !== 'ok') { closePops(); closeDrawer(); }
}
$('#gate-login').onclick = async () => {
  try {
    if (window.Sync.currentUser()) await window.Sync.signOut(); // 許可していないアカウントから切り替える
    await window.Sync.signIn();
  } catch (err) { toast('ログインできませんでした: ' + err.message); }
};

$('#sync').onclick = e => {
  if (syncState.status === 'off') {
    toast(window.FIREBASE_CONFIG ? '同期の準備中です…' : 'クラウド同期はまだ設定されていません');
    return;
  }
  if (syncState.status === 'signedout') {
    window.Sync.signIn().catch(err => toast('ログインできませんでした: ' + err.message));
    return;
  }
  openPop($('#pop-sync'), e.currentTarget);
};
$('#sync-now').onclick = () => { closePops(); window.Sync?.syncNow(); };
$('#sync-out').onclick = () => {
  closePops();
  if (confirm('ログアウトしますか？ログイン画面に戻ります（この端末のノートは残ります）。')) window.Sync?.signOut();
};

/* =========================================================
   起動
   ========================================================= */
fillIcons();
syncSeg($('#finger'), S.finger);
setTool('pen');
applyTheme();
renderSync();
window.addEventListener('resize', resize);
resize();
// 同期の仕組みを読み込む。読み込めなかったら（オフラインなど）、つながったときにもう一度
let syncTries = 0;
function startSync() {
  if (!window.FIREBASE_CONFIG) { setGate('ok'); return; } // 同期なし：端末内だけで使う
  if (window.Sync) return;
  if (locked()) setGate('checking');
  App.setSyncStatus(navigator.onLine ? 'syncing' : 'offline');
  const url = './sync.js?v=38' + (syncTries++ ? '&r=' + syncTries : '');
  return import(url)
    .then(() => swCacheNow())
    .catch(err => {
      if (locked()) setGate('error');
      App.setSyncStatus(navigator.onLine ? 'error' : 'offline', '同期を開始できませんでした（' + err.message + '）');
      window.addEventListener('online', startSync, { once: true });
    });
}

/* ---------- オフラインでも開けるように（Service Worker） ---------- */
function swCacheNow() {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller && !navigator.serviceWorker.ready) return;
  navigator.serviceWorker.ready.then(reg => {
    const page = location.href.split('#')[0];
    const extra = ['manifest.webmanifest', 'icon.svg'].map(f => new URL(f, location.href).href); // ホーム画面に追加したとき用
    const urls = [page, ...extra, ...performance.getEntriesByType('resource').map(e => e.name)];
    if (reg.active) reg.active.postMessage({ type: 'cache', page, urls });
  }).catch(() => {});
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(swCacheNow).catch(() => {});
}

loadBoards()
  .then(startSync)
  .catch(err => toast('データを開けませんでした: ' + err.message));

