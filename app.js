'use strict';

/* =========================================================
   保存（IndexedDB）
   クラウド同期を入れるときは、この Store を差し替える。
   ========================================================= */
const Store = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('canvas-note', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('boards', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('boards', mode);
      const req = fn(tx.objectStore('boards'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  };
  return {
    all: () => run('readonly', s => s.getAll()),
    put: b => run('readwrite', s => s.put(b)),
    del: id => run('readwrite', s => s.delete(id)),
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
const PAPER = '#ffffff';
const BG_LINE = '#e3e7ee';
const BG_MAJOR = '#cfd5df';
const BG_DOT = '#c4cad4';
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
  ruler: { on: false, cx: 0, cy: 0, a: 0 },
  sel: null,          // { set:Set<stroke>, bb, dx, dy }
  cur: null,          // 描画中のストローク
  lasso: null,        // 投げ縄の点（ワールド座標）
  undo: [], redo: [],
  penSeen: false,
  finger: LS.get('finger', 'auto'),
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
  if (!S.ruler.cx) { S.ruler.cx = W / 2; S.ruler.cy = H / 2; }
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

// 筆圧がある線は、太さが同じ区間ごとにまとめて描く
function runs(st) {
  const g = G(st);
  if (g.runs) return g.runs;
  const n = st.p.length / 3, out = [];
  if (!st.pr || n < 2) {
    out.push({ w: st.w, path: buildPath(st.p, 0, n - 1) });
  } else {
    const q = Math.max(0.2, st.w * 0.1);
    const wq = i => Math.max(q, Math.round(pressureWidth(st.w, (st.p[i * 3 + 2] + st.p[i * 3 + 5]) / 2) / q) * q);
    let start = 0, cw = wq(0);
    for (let i = 1; i < n - 1; i++) {
      const w = wq(i);
      if (w !== cw) { out.push({ w: cw, path: buildPath(st.p, start, i) }); start = i; cw = w; }
    }
    out.push({ w: cw, path: buildPath(st.p, start, n - 1) });
  }
  return g.runs = out;
}

function drawStroke(c, st) {
  c.strokeStyle = st.c;
  if (st.t === 'hl') c.globalAlpha = 0.42;
  for (const r of runs(st)) { c.lineWidth = r.w; c.stroke(r.path); }
  c.globalAlpha = 1;
}

/* ---------- 背景 ---------- */
function drawBg(c, r, scale, bg) {
  if (!bg || bg.type === 'none') return;
  let s = bg.size;
  while (s * scale < 8) s *= 2;
  const lw = 1 / scale;
  const x0 = Math.floor(r.x0 / s) * s, y0 = Math.floor(r.y0 / s) * s;
  if (bg.type === 'dots') {
    c.fillStyle = BG_DOT;
    const d = 2.2 / scale;
    for (let x = x0; x <= r.x1; x += s)
      for (let y = y0; y <= r.y1; y += s) c.fillRect(x - d / 2, y - d / 2, d, d);
    return;
  }
  c.lineWidth = lw;
  c.strokeStyle = BG_LINE;
  c.beginPath();
  if (bg.type === 'grid') for (let x = x0; x <= r.x1; x += s) { c.moveTo(x, r.y0); c.lineTo(x, r.y1); }
  for (let y = y0; y <= r.y1; y += s) { c.moveTo(r.x0, y); c.lineTo(r.x1, y); }
  c.stroke();
  if (bg.type === 'grid') {
    // 4マスごとに少し濃い線
    const M = s * 4;
    const mx0 = Math.floor(r.x0 / M) * M, my0 = Math.floor(r.y0 / M) * M;
    c.strokeStyle = BG_MAJOR;
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

function renderMain() {
  if (!S.board) return;
  const c = mc, v = S.view;
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.fillStyle = PAPER;
  c.fillRect(0, 0, W, H);
  c.setTransform(DPR * v.s, 0, 0, DPR * v.s, DPR * v.x, DPR * v.y);
  const r = viewRect();
  drawBg(c, r, v.s, S.board.bg);
  c.lineCap = 'round'; c.lineJoin = 'round';
  const sel = S.sel, moving = sel && (sel.dx || sel.dy);
  for (const st of S.strokes) {
    if (moving && sel.set.has(st)) continue;
    const b = bbox(st);
    if (b.x1 < r.x0 || b.x0 > r.x1 || b.y1 < r.y0 || b.y0 > r.y1) continue;
    drawStroke(c, st);
  }
  if (moving) {
    c.translate(sel.dx, sel.dy);
    for (const st of sel.set) drawStroke(c, st);
  }
  $('#zoom').textContent = Math.round(v.s * 100) + '%';
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
    c.fillStyle = 'rgba(37,99,235,.06)'; c.fill();
    c.setLineDash([6, 5]); c.lineWidth = 1.5; c.strokeStyle = '#2563eb'; c.stroke(); c.setLineDash([]);
  }

  // 選択範囲
  const sb = $('#selbar');
  if (S.sel) {
    const bb = S.sel.bb;
    const a = toScreen(bb.x0 + S.sel.dx, bb.y0 + S.sel.dy), b = toScreen(bb.x1 + S.sel.dx, bb.y1 + S.sel.dy);
    c.setLineDash([6, 5]); c.lineWidth = 1.5; c.strokeStyle = '#2563eb';
    c.strokeRect(a.x - 6, a.y - 6, b.x - a.x + 12, b.y - a.y + 12);
    c.setLineDash([]);
    if (act && act.type === 'move') sb.hidden = true;
    else {
      sb.hidden = false;
      const bw = sb.offsetWidth, bh = sb.offsetHeight;
      let x = (a.x + b.x) / 2 - bw / 2, y = a.y - bh - 16;
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
    c.fillStyle = 'rgba(255,255,255,.5)'; c.fill();
    c.lineWidth = 1; c.strokeStyle = 'rgba(0,0,0,.45)'; c.stroke();
  }
}

/* =========================================================
   定規
   ========================================================= */
function rulerLocal(x, y) {
  const r = S.ruler, dx = x - r.cx, dy = y - r.cy, co = Math.cos(r.a), si = Math.sin(r.a);
  return { lx: dx * co + dy * si, ly: -dx * si + dy * co };
}
function rulerToScreen(lx, ly) {
  const r = S.ruler, co = Math.cos(r.a), si = Math.sin(r.a);
  return { x: r.cx + lx * co - ly * si, y: r.cy + lx * si + ly * co };
}
function rulerHit(x, y) {
  if (!S.ruler.on) return null;
  const { lx, ly } = rulerLocal(x, y);
  if (Math.hypot(lx - RULER_KNOB, ly) <= 24) return 'knob';
  if (Math.abs(ly) <= RULER_W / 2) return 'body';
  return null;
}
function rulerSnapSide(x, y) {
  const { ly } = rulerLocal(x, y);
  const d = Math.abs(ly);
  return d > RULER_W / 2 && d <= RULER_W / 2 + RULER_SNAP ? Math.sign(ly) : 0;
}
function rulerProject(x, y, side, lineW) {
  const { lx } = rulerLocal(x, y);
  return rulerToScreen(lx, side * (RULER_W / 2 + lineW / 2 + 0.5));
}
function setRulerAngle(a) {
  // 15° の倍数の近くでは吸着
  const step = Math.PI / 12, near = Math.round(a / step) * step;
  if (Math.abs(a - near) < 0.025) a = near;
  S.ruler.a = a;
}
function rulerDeg() {
  let d = Math.round((-S.ruler.a * 180 / Math.PI) % 180);
  if (d < 0) d += 180;
  return d === 180 ? 0 : d;
}

function drawRuler(c) {
  const r = S.ruler, L = Math.hypot(W, H) * 1.5, hw = RULER_W / 2;
  c.save();
  c.translate(r.cx, r.cy);
  c.rotate(r.a);
  c.fillStyle = 'rgba(148,163,184,.22)';
  c.fillRect(-L, -hw, L * 2, RULER_W);
  c.strokeStyle = 'rgba(51,65,85,.55)'; c.lineWidth = 1;
  c.beginPath();
  c.moveTo(-L, -hw); c.lineTo(L, -hw); c.moveTo(-L, hw); c.lineTo(L, hw);
  for (let x = -Math.floor(L / 10) * 10; x <= L; x += 10) {
    const t = x % 100 === 0 ? 16 : x % 50 === 0 ? 11 : 6;
    c.moveTo(x, -hw); c.lineTo(x, -hw + t);
    c.moveTo(x, hw); c.lineTo(x, hw - t);
  }
  c.stroke();
  // 回転つまみ
  c.beginPath(); c.arc(RULER_KNOB, 0, 18, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,.95)'; c.fill();
  c.strokeStyle = 'rgba(51,65,85,.5)'; c.stroke();
  c.beginPath(); c.arc(RULER_KNOB, 0, 8, -Math.PI * 0.9, Math.PI * 0.4);
  c.strokeStyle = '#334155'; c.lineWidth = 1.6; c.stroke();
  const ex = RULER_KNOB + 8 * Math.cos(Math.PI * 0.4), ey = 8 * Math.sin(Math.PI * 0.4);
  c.beginPath(); c.moveTo(ex - 4, ey - 1); c.lineTo(ex, ey); c.lineTo(ex + 1, ey - 4); c.stroke();
  c.restore();
  // 角度
  const label = rulerDeg() + '°';
  c.font = '600 13px system-ui, sans-serif';
  const tw = c.measureText(label).width + 16;
  c.fillStyle = 'rgba(31,35,40,.85)';
  c.beginPath(); c.roundRect ? c.roundRect(r.cx - tw / 2, r.cy - 12, tw, 24, 12) : c.rect(r.cx - tw / 2, r.cy - 12, tw, 24); c.fill();
  c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(label, r.cx, r.cy + 0.5);
}

/* =========================================================
   履歴
   ========================================================= */
function pushUndo(before) {
  S.undo.push(before);
  if (S.undo.length > 200) S.undo.shift();
  S.redo.length = 0;
  changed();
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
let saveTimer = 0;
function changed() {
  if (S.board) S.board.updatedAt = Date.now();
  updateHistoryButtons();
  scheduleSave();
  render();
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!S.board) return;
  S.board.strokes = S.strokes;
  S.board.view = { ...S.view };
  Store.put(S.board).catch(err => toast('保存に失敗しました: ' + err.message));
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
  const res = [];
  for (const st of S.strokes) {
    const bb = bbox(st);
    if (bb.x1 < ex0 || bb.x0 > ex1 || bb.y1 < ey0 || bb.y0 > ey1) { res.push(st); continue; }
    if (partial) {
      const parts = splitStroke(st, a, w, r);
      if (parts) { didChange = true; res.push(...parts); } else res.push(st);
    } else if (strokeHits(st, a, w, r + st.w / 2)) didChange = true;
    else res.push(st);
  }
  if (didChange) { S.strokes = res; act.changed = true; renderMainSoon(); }
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
  const set = new Set();
  for (const st of S.strokes) {
    const b = bbox(st);
    if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
    const n = st.p.length / 3, step = Math.max(1, Math.floor(n / 60));
    let inside = 0, total = 0;
    for (let i = 0; i < n; i += step) { total++; if (pointInPoly(st.p[i * 3], st.p[i * 3 + 1], poly)) inside++; }
    if (inside / total >= 0.5) set.add(st);
  }
  setSelection(set.size ? set : null);
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
  const before = S.strokes.slice(), off = 24 / S.view.s, ns = new Set();
  for (const st of S.strokes) {
    if (!S.sel.set.has(st)) continue;
    const p = st.p.slice();
    for (let i = 0; i < p.length; i += 3) { p[i] += off; p[i + 1] += off; }
    const n = { ...st, id: uid(), p };
    ns.add(n);
  }
  S.strokes = S.strokes.concat([...ns]);
  setSelection(ns);
  pushUndo(before);
}
function recolorSelection(color) {
  if (S.sel) mapSelection(st => ({ ...st, c: color }));
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
    S.ruler.cx = act.r0.cx + m.x - act.m0.x;
    S.ruler.cy = act.r0.cy + m.y - act.m0.y;
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
function viewChanged() { scheduleSave(); render(); }

function zoomAt(x, y, f) {
  const v = S.view, s = clamp(v.s * f, 0.05, 16);
  f = s / v.s;
  S.view = { x: x - (x - v.x) * f, y: y - (y - v.y) * f, s };
  viewChanged();
}

function cancelAction() {
  if (!act) return;
  if (act.type === 'draw') S.cur = null;
  if (act.type === 'erase' && act.changed) S.strokes = act.before;
  if (act.type === 'lasso') S.lasso = null;
  if (act.type === 'move') { S.sel.dx = S.sel.dy = 0; }
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

  const x = e.clientX, y = e.clientY;
  if (e.button === 1 || spaceDown || S.tool === 'hand' || (e.pointerType === 'touch' && fingerPans())) {
    act = { type: 'pan', pid: e.pointerId, lx: x, ly: y };
    setCursor();
    return;
  }
  if (e.button !== 0 && e.pointerType === 'mouse') return;

  const rh = rulerHit(x, y);
  if (rh) {
    act = rh === 'knob'
      ? { type: 'ruler-rot', pid: e.pointerId, off: Math.atan2(y - S.ruler.cy, x - S.ruler.cx) - S.ruler.a }
      : { type: 'ruler-move', pid: e.pointerId, lx: x, ly: y };
    return;
  }

  // ペンのおしり（消しゴムボタン）は一時的に消しゴム
  const tool = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32)) ? 'eraser' : S.tool;
  switch (tool) {
    case 'pen': case 'hl': {
      S.sel = null;
      const cfg = S.tool === 'hl' ? S.hl : S.pen;
      const st = { id: uid(), t: S.tool, c: cfg.color, w: cfg.width, pr: S.tool === 'pen' && e.pointerType === 'pen', p: [] };
      act = { type: 'draw', pid: e.pointerId, st, snap: S.ruler.on ? rulerSnapSide(x, y) : 0 };
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
    case 'lasso':
      if (inSelection(x, y)) {
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

function addPoint(e) {
  const st = act.st;
  let x = e.clientX, y = e.clientY;
  if (act.snap) ({ x, y } = rulerProject(x, y, act.snap, st.w * S.view.s));
  const w = toWorld(x, y);
  const pr = st.pr ? (e.pressure || 0.5) : 0.5;
  const p = st.p, n = p.length;
  if (n && Math.hypot(w.x - p[n - 3], w.y - p[n - 2]) * S.view.s < 0.8) return;
  p.push(w.x, w.y, pr);
}

function onMove(e) {
  if (e.pointerType !== 'touch') {
    hover = { x: e.clientX, y: e.clientY };
    if (S.tool === 'eraser') renderOverSoon();
    if (!act && S.tool === 'lasso') over.classList.toggle('c-move', inSelection(e.clientX, e.clientY));
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

  switch (act.type) {
    case 'draw': for (const ev of evs) addPoint(ev); renderOverSoon(); break;
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
    case 'pan':
      S.view = { ...S.view, x: S.view.x + dx, y: S.view.y + dy };
      viewChanged();
      break;
    case 'ruler-move':
      S.ruler.cx += dx; S.ruler.cy += dy;
      renderOverSoon();
      break;
    case 'ruler-rot':
      setRulerAngle(Math.atan2(e.clientY - S.ruler.cy, e.clientX - S.ruler.cx) - act.off);
      renderOverSoon();
      break;
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
  switch (a.type) {
    case 'draw':
      S.cur = null;
      if (a.st.p.length) {
        const before = S.strokes.slice();
        S.strokes.push(a.st);
        pushUndo(before);
      }
      break;
    case 'erase':
      if (a.changed) pushUndo(a.before);
      if (e.pointerType === 'touch') hover = null;
      break;
    case 'lasso': {
      const poly = S.lasso;
      S.lasso = null;
      if (poly.length > 2) selectByLasso(poly); else setSelection(null);
      break;
    }
    case 'move': commitMove(); break;
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
    S.ruler.a += Math.sign(dy || dx) * step;
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
  if (typing()) return;
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
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
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
function toggleRuler() {
  S.ruler.on = !S.ruler.on;
  if (S.ruler.on) { S.ruler.cx = W / 2; S.ruler.cy = H / 2; }
  $('#btn-ruler').classList.toggle('active', S.ruler.on);
  renderOverSoon();
}

function swatchHTML(colors, current, attr = 'data-color') {
  const isCustom = !colors.includes(current);
  return colors.map(c => `<button class="sw ${c === current ? 'active' : ''}" ${attr}="${c}" title="${c}"><i style="background:${c}"></i></button>`).join('')
    + `<label class="sw custom ${isCustom ? 'active' : ''}" title="色を選ぶ"><i ${isCustom ? `style="background:${current}"` : ''}></i><input type="color" value="${isCustom ? current : '#000000'}"></label>`;
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
      }).join('');
    box.querySelectorAll('[data-color]').forEach(b => b.onclick = () => { cfg.color = b.dataset.color; saveToolPrefs(); renderOptions(); });
    box.querySelector('input[type=color]').oninput = e => { cfg.color = e.target.value; saveToolPrefs(); };
    box.querySelector('input[type=color]').onchange = () => renderOptions();
    box.querySelectorAll('[data-width]').forEach(b => b.onclick = () => { cfg.width = +b.dataset.width; saveToolPrefs(); renderOptions(); });
  } else if (t === 'eraser') {
    const er = S.eraser;
    box.innerHTML = `<div class="seg" id="er-mode"><button data-v="object" class="${er.mode === 'object' ? 'active' : ''}">オブジェクト</button><button data-v="partial" class="${er.mode === 'partial' ? 'active' : ''}">部分</button></div><span class="sep"></span>`
      + ERASER_SIZES.map(s => `<button class="wd ${s === er.size ? 'active' : ''}" data-size="${s}" title="大きさ ${s}"><i style="width:${s / 2 + 4}px;height:${s / 2 + 4}px;background:none;border:1.5px solid currentColor"></i></button>`).join('');
    box.querySelectorAll('#er-mode button').forEach(b => b.onclick = () => { er.mode = b.dataset.v; saveToolPrefs(); renderOptions(); });
    box.querySelectorAll('[data-size]').forEach(b => b.onclick = () => { er.size = +b.dataset.size; saveToolPrefs(); renderOptions(); });
  } else box.innerHTML = '';
}
function saveToolPrefs() { LS.set('pen', S.pen); LS.set('hl', S.hl); LS.set('eraser', S.eraser); }

function renderSelColors() {
  const box = $('#sel-colors');
  box.innerHTML = PEN_COLORS.map(c => `<button class="sw" data-color="${c}" title="${c}"><i style="background:${c}"></i></button>`).join('');
  box.querySelectorAll('[data-color]').forEach(b => b.onclick = () => recolorSelection(b.dataset.color));
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
  if (!e.target.closest('.pop') && !e.target.closest('#btn-bg') && !e.target.closest('#btn-more')) closePops();
}, true);

function syncSeg(el, value) { el.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === String(value))); }
function syncBgUI() { syncSeg($('#bg-type'), S.board.bg.type); syncSeg($('#bg-size'), S.board.bg.size); }

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
$('#pop-more').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  closePops();
  ({ fit: fitAll, png: exportPNG, export: exportJSON, import: () => $('#file-import').click() })[b.dataset.act]();
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

function exportPNG() {
  const b = contentBox(S.strokes);
  if (!b) { toast('まだ何も描かれていません'); return; }
  const pad = 40;
  let scale = 2;
  const bw = b.x1 - b.x0 + pad * 2, bh = b.y1 - b.y0 + pad * 2;
  scale = Math.min(scale, 8000 / bw, 8000 / bh);
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(bw * scale); cv.height = Math.ceil(bh * scale);
  const c = cv.getContext('2d');
  c.fillStyle = PAPER; c.fillRect(0, 0, cv.width, cv.height);
  c.setTransform(scale, 0, 0, scale, -(b.x0 - pad) * scale, -(b.y0 - pad) * scale);
  drawBg(c, { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }, scale, S.board.bg);
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const st of S.strokes) drawStroke(c, st);
  cv.toBlob(blob => download(blob, safeName(S.board.name) + '.png'), 'image/png');
}

async function exportJSON() {
  saveNow();
  const boards = await Store.all();
  const data = { app: 'canvas-note', version: 1, exportedAt: new Date().toISOString(), boards };
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
    for (const b of data.boards) if (b && b.id && Array.isArray(b.strokes)) await Store.put(b);
    await loadBoards();
    toast('読み込みました');
  } catch (err) { toast('読み込めませんでした: ' + err.message); }
});

/* =========================================================
   ボード管理
   ========================================================= */
function newBoardData(name) {
  const t = Date.now();
  return { id: uid(), name, createdAt: t, updatedAt: t, bg: LS.get('lastBg', { type: 'grid', size: 32 }), view: { x: 0, y: 0, s: 1 }, strokes: [] };
}
async function loadBoards() {
  S.boards = await Store.all();
  if (!S.boards.length) {
    const b = newBoardData('はじめてのボード');
    await Store.put(b);
    S.boards = [b];
  }
  const last = LS.get('lastBoard', null);
  S.board = null; // 読み込み直後なので、古いメモリ内容で上書き保存しない
  openBoard(S.boards.find(b => b.id === last) || newest());
}
const newest = () => S.boards.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];

function openBoard(b) {
  if (S.board && S.board !== b) saveNow();
  if (act) cancelAction();
  S.board = b;
  S.strokes = b.strokes || [];
  S.view = b.view ? { ...b.view } : { x: 0, y: 0, s: 1 };
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

function renderBoardList() {
  const ul = $('#board-list');
  const fmt = t => new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  ul.innerHTML = '';
  for (const b of S.boards.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
    const li = document.createElement('li');
    if (b === S.board) li.className = 'current';
    li.innerHTML = `<div class="meta"><div class="name"></div><div class="date">${fmt(b.updatedAt)}</div></div>
      <button class="ibtn" data-icon="edit" title="名前を変更"></button>
      <button class="ibtn" data-icon="trash" title="削除"></button>`;
    li.querySelector('.name').textContent = b.name;
    fillIcons(li);
    const [ren, del] = li.querySelectorAll('button');
    li.onclick = () => { openBoard(b); closeDrawer(); };
    ren.onclick = e => {
      e.stopPropagation();
      const name = prompt('ボード名', b.name);
      if (name && name.trim()) renameBoard(b, name.trim());
    };
    del.onclick = async e => {
      e.stopPropagation();
      if (!confirm(`「${b.name}」を削除します。元に戻せません。`)) return;
      await Store.del(b.id);
      S.boards = S.boards.filter(x => x !== b);
      if (!S.boards.length) { const nb = newBoardData('新しいボード'); await Store.put(nb); S.boards = [nb]; }
      if (b === S.board) { S.board = null; openBoard(newest()); } else renderBoardList();
    };
    ul.appendChild(li);
  }
}
function renameBoard(b, name) {
  b.name = name;
  if (b === S.board) { $('#title').value = name; document.title = name + ' – Canvas Note'; saveNow(); }
  else Store.put(b);
  renderBoardList();
}

$('#title').addEventListener('change', e => {
  const v = e.target.value.trim();
  if (v) renameBoard(S.board, v); else e.target.value = S.board.name;
});
$('#title').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

$('#btn-new').onclick = async () => {
  saveNow();
  const b = newBoardData('ボード ' + (S.boards.length + 1));
  await Store.put(b);
  S.boards.push(b);
  openBoard(b);
  closeDrawer();
};

function openDrawer() { renderBoardList(); $('#drawer').classList.add('open'); $('#drawer-scrim').hidden = false; }
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
   起動
   ========================================================= */
fillIcons();
syncSeg($('#finger'), S.finger);
setTool('pen');
window.addEventListener('resize', resize);
resize();
loadBoards().catch(err => toast('データを開けませんでした: ' + err.message));
