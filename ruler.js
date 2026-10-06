'use strict';
/* =========================================================
   定規（app.js の後に読み込む。S, W, H, toScreen などを使う）
   - 直線定規：縁に沿ってまっすぐ描ける
   - 関数定規：y = f(x) や x^2+y^2=9 のような式を自由に入力。カーブの近くから描くとカーブに沿う
   どちらもキャンバスに固定（スクロール・ズームで一緒に動く）
   ========================================================= */
const CURVE_KNOB = { x: -80, y: 80 };  // 関数定規の回転つまみ（原点からの画面px）
const CURVE_GRIP = { x: -80, y: -80 }; // 関数定規の移動つまみ（原点はカーブが通ることが多いので離す）
const CURVE_SNAP = 30;                // カーブからこの距離（画面px）以内で描き始めると吸着
const GRID_SNAP = 10;                 // 原点を方眼の交点に吸着させる距離（画面px）
const FN_EXAMPLES = [
  ['関数', ['x^2', 'x^3-3x', '2x^2-4x+1', 'sqrt(x)', '1/x', 'log(x)', 'ln(x)', '2^x', 'sin(x)', 'abs(x)']],
  ['円・二次曲線', ['x^2+y^2=9', '(x-2)^2+(y-1)^2=4', 'x^2/9+y^2/4=1', 'x^2/4-y^2=1', 'xy=4', 'y^2=4x']],
];

/* ---------- 座標 ----------
   関数定規：(wx, wy) = 原点
   直線定規：(wx, wy) = 上の縁の上の点。定規の幅は画面pxで一定なので、
             縁をキャンバスに固定しておけば、ズームしても縁は方眼の線からずれない */
const gridStep = () => (S.board && S.board.bg && S.board.bg.type !== 'none' ? S.board.bg.size : 0);
function rulerOrigin() {
  const R = S.ruler, p = toScreen(R.wx, R.wy);
  if (R.type !== 'line') return p;
  const hw = RULER_W / 2; // 中心 = 上の縁から hw だけ内側
  return { x: p.x - hw * Math.sin(R.a), y: p.y + hw * Math.cos(R.a) };
}
// 画面上の中心 (cx, cy) に定規を置く
function setRulerCenter(cx, cy) {
  const R = S.ruler, hw = R.type === 'line' ? RULER_W / 2 : 0;
  const w = toWorld(cx + hw * Math.sin(R.a), cy - hw * Math.cos(R.a));
  R.wx = w.x; R.wy = w.y;
}

function rulerLocal(x, y) {
  const o = rulerOrigin(), a = S.ruler.a, dx = x - o.x, dy = y - o.y, co = Math.cos(a), si = Math.sin(a);
  return { lx: dx * co + dy * si, ly: -dx * si + dy * co };
}
function rulerToScreen(lx, ly) {
  const o = rulerOrigin(), a = S.ruler.a, co = Math.cos(a), si = Math.sin(a);
  return { x: o.x + lx * co - ly * si, y: o.y + lx * si + ly * co };
}
// 方眼に吸着させながら動かす
function moveRulerTo(wx, wy) {
  const g = gridStep(), R = S.ruler, near = v => Math.round(v / g) * g;
  if (g && R.type === 'fn') {
    // 原点を方眼の交点に
    const sx = near(wx), sy = near(wy);
    if (Math.hypot(sx - wx, sy - wy) * S.view.s <= GRID_SNAP) { wx = sx; wy = sy; }
  } else if (g && R.type === 'line') {
    // 縁を方眼の線に（0° / 90° / 180° / 270° のとき）
    const q = R.a / (Math.PI / 2), k = Math.round(q);
    if (Math.abs(q - k) < 1e-6) {
      if (k % 2 === 0) { if (Math.abs(near(wy) - wy) * S.view.s <= GRID_SNAP) wy = near(wy); }
      else if (Math.abs(near(wx) - wx) * S.view.s <= GRID_SNAP) wx = near(wx);
    }
  }
  R.wx = wx; R.wy = wy;
}
// 中心を軸に回す。snap = 15° ごとに吸着
function setRulerAngle(a, snap = true) {
  if (snap) {
    const step = Math.PI / 12, near = Math.round(a / step) * step;
    if (Math.abs(a - near) < 0.025) a = near;
  }
  const c = rulerOrigin();
  S.ruler.a = a;
  setRulerCenter(c.x, c.y);
}
function rulerDeg() {
  const m = S.ruler.type === 'line' ? 180 : 360; // 直線は 180° 回すと同じ形
  let d = Math.round((-S.ruler.a * 180 / Math.PI) % m);
  if (d < 0) d += m;
  return d === m ? 0 : d;
}

function rulerHit(x, y) {
  if (!S.ruler.on) return null;
  const { lx, ly } = rulerLocal(x, y);
  if (S.ruler.type === 'fn') {
    if (Math.hypot(lx - CURVE_KNOB.x, ly - CURVE_KNOB.y) <= 22) return 'knob';
    if (Math.hypot(lx - CURVE_GRIP.x, ly - CURVE_GRIP.y) <= 22) return 'body';
    return null;
  }
  if (Math.hypot(lx - RULER_KNOB, ly) <= 24) return 'knob';
  if (Math.abs(ly) <= RULER_W / 2) return 'body';
  return null;
}

/* ---------- 直線定規の吸着 ---------- */
function rulerSnapSide(x, y) {
  if (S.ruler.type !== 'line') return 0;
  const d = Math.abs(rulerLocal(x, y).ly);
  return d > RULER_W / 2 && d <= RULER_W / 2 + RULER_SNAP ? Math.sign(rulerLocal(x, y).ly) : 0;
}
// 線の中心を縁の線にぴったり乗せる（縁を方眼に合わせれば、線も方眼の線に乗る）
function rulerProject(x, y, side) {
  return rulerToScreen(rulerLocal(x, y).lx, side * RULER_W / 2);
}

/* =========================================================
   式の読み取り（eval は使わない）
   ・y = f(x) の形（「x^2」だけでも可）        → 関数のグラフ
   ・x と y の方程式（x^2+y^2=9、y^2=4x など） → 円・楕円・双曲線などの曲線
   使えるもの：+ - * / ^ ( ) =、2x のような掛け算の省略、
   sqrt √ cbrt abs |…| sin cos tan asin acos atan exp ln log(=log10) log2 log_b(x)、pi π e
   ========================================================= */
const FN = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, exp: Math.exp, ln: Math.log,
  log: Math.log10, log10: Math.log10, log2: Math.log2,
};
const CONST = { pi: Math.PI, e: Math.E };
const NAMES = [...Object.keys(FN), ...Object.keys(CONST), 'x', 'y'].sort((a, b) => b.length - a.length);

function normalizeExpr(s) {
  return String(s).toLowerCase().replace(/\s+/g, '')
    .replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/＝/g, '=')
    .replace(/π/g, 'pi').replace(/√/g, 'sqrt').replace(/²/g, '^2').replace(/³/g, '^3').replace(/｜/g, '|');
}
function tokenize(s) {
  const t = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const txt = s.slice(i, j), v = parseFloat(txt);
      if (!Number.isFinite(v) || txt.split('.').length > 2) throw new Error(`「${txt}」は数として読めません`);
      t.push({ k: 'num', v }); i = j; continue;
    }
    if (/[a-z]/.test(c)) {
      const name = NAMES.find(n => s.startsWith(n, i));
      if (!name) throw new Error(`「${s.slice(i).match(/^[a-z]+/)[0]}」は使えません`);
      t.push({ k: 'id', v: name }); i += name.length; continue;
    }
    if ('+-*/^()_|'.includes(c)) { t.push({ k: c }); i++; continue; }
    throw new Error(`「${c}」は使えません`);
  }
  return t;
}
const usesY = s => tokenize(s).some(t => t.k === 'id' && t.v === 'y');

// 式（= を含まない片側）を (x, y) => 数 の関数にする
function compileSide(s) {
  if (!s) throw new Error('式が空です');
  const t = tokenize(s);
  let p = 0, absDepth = 0; // |…| の中では次の | は閉じかっこ
  const peek = () => t[p], next = () => t[p++];
  const is = k => t[p] && t[p].k === k;
  const expect = k => {
    if (!is(k)) throw new Error(k === ')' ? '「)」が足りません' : k === '|' ? '「|」が足りません' : '式が正しくありません');
    p++;
  };
  const startsPrimary = tk => tk && (tk.k === 'num' || tk.k === 'id' || tk.k === '(' || (tk.k === '|' && !absDepth));

  function expr() {
    let a = term();
    while (is('+') || is('-')) {
      const op = next().k, b = term(), l = a;
      a = op === '+' ? (x, y) => l(x, y) + b(x, y) : (x, y) => l(x, y) - b(x, y);
    }
    return a;
  }
  function term() {
    let a = unary();
    for (;;) {
      const tk = peek();
      if (tk && (tk.k === '*' || tk.k === '/')) {
        next();
        const b = unary(), l = a;
        a = tk.k === '*' ? (x, y) => l(x, y) * b(x, y) : (x, y) => l(x, y) / b(x, y);
      } else if (startsPrimary(tk)) { // 2x, x(x+1), xy などの省略された掛け算
        const b = power(), l = a;
        a = (x, y) => l(x, y) * b(x, y);
      } else return a;
    }
  }
  function unary() {
    if (is('-')) { next(); const a = unary(); return (x, y) => -a(x, y); }
    if (is('+')) { next(); return unary(); }
    return power();
  }
  function power() {
    const b = primary();
    if (!is('^')) return b;
    next();
    const e = unary();
    return (x, y) => Math.pow(b(x, y), e(x, y));
  }
  function fnArg() {
    if (is('(')) { next(); const a = expr(); expect(')'); return a; }
    return power(); // sqrt x, sin x のようにかっこなしでも書ける
  }
  function primary() {
    const tk = next();
    if (!tk) throw new Error('式が途中で終わっています');
    if (tk.k === 'num') { const v = tk.v; return () => v; }
    if (tk.k === '(') { const a = expr(); expect(')'); return a; }
    if (tk.k === '|' && !absDepth) {
      absDepth++;
      const a = expr();
      expect('|');
      absDepth--;
      return (x, y) => Math.abs(a(x, y));
    }
    if (tk.k === 'id') {
      if (tk.v === 'x') return x => x;
      if (tk.v === 'y') return (x, y) => y;
      if (tk.v in CONST) { const v = CONST[tk.v]; return () => v; }
      if (tk.v === 'log' && is('_')) { // log_2(x)
        next();
        const b = primary(), arg = fnArg();
        return (x, y) => Math.log(arg(x, y)) / Math.log(b(x, y));
      }
      const f = FN[tk.v], arg = fnArg();
      return (x, y) => f(arg(x, y));
    }
    throw new Error('式が正しくありません');
  }

  const f = expr();
  if (p < t.length) throw new Error(t[p].k === ')' ? '「(」が足りません' : '式が正しくありません');
  return f;
}

// 定規の式を読む → { kind: 'fn', f(x) } または { kind: 'implicit', F(x, y) }（F = 0 が曲線）
function parseRulerExpr(src) {
  const s = normalizeExpr(src);
  if (!s) throw new Error('式を入れてください');
  const parts = s.split('=');
  if (parts.length > 2) throw new Error('「=」は1つだけにしてください');
  if (parts.length === 1) {
    const f = compileSide(s);
    return usesY(s) ? { kind: 'implicit', F: f } : { kind: 'fn', f: x => f(x, 0) };
  }
  const [L, R] = parts;
  if (!L || !R) throw new Error('「=」の両側に式を書いてください');
  const fl = compileSide(L), fr = compileSide(R);
  if (L === 'y' && !usesY(R)) return { kind: 'fn', f: x => fr(x, 0) };
  return { kind: 'implicit', F: (x, y) => fl(x, y) - fr(x, y) };
}
// y = f(x) の形の式の f（テストや旧データ用）
function compileExpr(src) {
  const c = parseRulerExpr(src);
  if (c.kind !== 'fn') throw new Error('y = f(x) の形ではありません');
  return c.f;
}

const SUPS = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
const toSup = s => [...s].map(c => SUPS[c]).join('');
const prettySide = s => s
  .replace(/\^\((-?\d+)\)/g, (_, d) => toSup(d))
  .replace(/\^(-?\d+)(?![.\d])/g, (_, d) => toSup(d))
  .replace(/sqrt/g, '√').replace(/pi/g, 'π').replace(/\*/g, '·')
  .replace(/([^(+*/^-])-/g, '$1 − ').replace(/-/g, '−').replace(/\+/g, ' + ');
function prettyExpr(src) {
  const s = normalizeExpr(src), parts = s.split('=');
  if (parts.length === 2) return prettySide(parts[0]) + ' = ' + prettySide(parts[1]);
  let hasY = false;
  try { hasY = usesY(s); } catch {}
  return hasY ? prettySide(s) + ' = 0' : 'y = ' + prettySide(s);
}

let compiled = { src: null, c: null, err: '' };
function rulerParsed() {
  const src = S.ruler.expr;
  if (compiled.src !== src) {
    try { compiled = { src, c: parseRulerExpr(src), err: '' }; }
    catch (e) { compiled = { src, c: null, err: e.message }; }
  }
  return compiled.c;
}

/* =========================================================
   カーブの計算（定規の単位 1目盛 = 1 で計算し、キャッシュする）
   ・y = f(x)：画面上で約1.5pxおきに点を打つ。定義域の端（√x の 0 など）は
     二分法で詰め、漸近線（1/x など）では線を切る。
   ・方程式 F(x, y) = 0：画面を約5pxのマス目に分け、F の符号が変わる所を
     つないで線にし（マーチングスクエア）、各点をニュートン法で曲線上に寄せる。
   ========================================================= */
let curveCache = { key: '', expr: null, segs: [] };
function rulerCurve() {
  const R = S.ruler, c = rulerParsed();
  if (!c) return [];
  // ピンチ中は作り直さない（単位系で持っているので形はそのまま正しい）
  if (act && act.type === 'pinch' && curveCache.expr === R.expr) return curveCache.segs;
  const su = R.unit * S.view.s, o = rulerOrigin();
  const far = Math.max(Math.hypot(o.x, o.y), Math.hypot(W - o.x, o.y), Math.hypot(o.x, H - o.y), Math.hypot(W - o.x, H - o.y));
  const zb = Math.round(Math.log2(su) * 4), ub = Math.ceil(Math.log2(far / su + 2) * 2);
  const key = [R.expr, zb, ub].join('|');
  if (curveCache.key === key) return curveCache.segs;
  const U = Math.pow(2, ub / 2), suB = Math.pow(2, zb / 4);
  const segs = c.kind === 'fn' ? sampleFn(c.f, U, 1.5 / suB) : traceImplicit(c.F, U, 5 / suB);
  curveCache = { key, expr: R.expr, segs };
  return segs;
}

function sampleFn(f, U, px) {
  const maxStep = px * 4;
  const val = u => { const v = f(u); return Number.isFinite(v) && Math.abs(v) <= U ? v : NaN; };
  const edge = (a, b) => { for (let i = 0; i < 50; i++) { const m = (a + b) / 2; if (Number.isFinite(val(m))) a = m; else b = m; } return a; };
  const segs = [];
  let cur = [];
  const brk = () => { if (cur.length >= 4) segs.push(cur); cur = []; };
  let u = -U, prevU = null, prevV = NaN;
  for (let count = 0; u <= U && count < 200000; count++) {
    const v = val(u);
    if (Number.isFinite(v)) {
      if (prevU !== null && !Number.isFinite(prevV)) { brk(); const ue = edge(u, prevU); cur.push(ue, val(ue)); }
      else if (Number.isFinite(prevV) && Math.hypot(u - prevU, v - prevV) > px * 20) brk(); // 値が飛んだ
      cur.push(u, v);
    } else if (Number.isFinite(prevV)) {
      const ue = edge(prevU, u);
      cur.push(ue, val(ue));
      brk();
    }
    let du = maxStep;
    if (Number.isFinite(v)) {
      const h = 1e-7 * Math.max(1, Math.abs(u)), sl = (f(u + h) - v) / h;
      if (Number.isFinite(sl)) du = px / Math.sqrt(1 + sl * sl);
    }
    prevU = u; prevV = v;
    u += clamp(du, 1e-9 * Math.max(1, Math.abs(u)), maxStep);
  }
  brk();
  return segs;
}

// (u, v) の近くの、F = 0 の上の点。曲線上と言えなければ null（1/x のような符号の飛びを除く）
function refineOnCurve(F, u, v, h) {
  const grad = (x, y, f) => {
    const e = 1e-7 * (1 + Math.abs(x) + Math.abs(y));
    return [(F(x + e, y) - f) / e, (F(x, y + e) - f) / e];
  };
  let x = u, y = v;
  for (let k = 0; k < 4; k++) {
    const f = F(x, y);
    if (!Number.isFinite(f)) break;
    const [gx, gy] = grad(x, y, f), g2 = gx * gx + gy * gy;
    if (!(g2 > 0) || !Number.isFinite(g2)) break;
    const nx = x - f * gx / g2, ny = y - f * gy / g2;
    if (Math.hypot(nx - u, ny - v) > h * 1.5) break;
    x = nx; y = ny;
  }
  const f = F(x, y);
  if (!Number.isFinite(f)) return null;
  const [gx, gy] = grad(x, y, f), g = Math.hypot(gx, gy);
  return Math.abs(f) <= g * h * 0.5 ? [x, y] : null;
}

function traceImplicit(F, U, cell) {
  const n = Math.min(Math.ceil(2 * U / cell), 900), h = 2 * U / n, N1 = n + 1;
  const val = new Float64Array(N1 * N1);
  for (let j = 0; j <= n; j++) {
    const y = -U + j * h;
    for (let i = 0; i <= n; i++) val[j * N1 + i] = F(-U + i * h, y);
  }
  // 辺ごとの交点（辺の番号：横の辺 = 頂点番号*2、縦の辺 = 頂点番号*2+1）
  const pts = new Map();
  const edgePoint = id => {
    if (pts.has(id)) return pts.get(id);
    const k = id >> 1, i = k % N1, j = (k - i) / N1, vert = id & 1;
    const a = val[k], b = vert ? val[k + N1] : val[k + 1], t = a / (a - b);
    const p = refineOnCurve(F, -U + (i + (vert ? 0 : t)) * h, -U + (j + (vert ? t : 0)) * h, h);
    pts.set(id, p);
    return p;
  };
  // マスごとの線分（どの辺とどの辺を結ぶか）
  const pairs = [];
  const add = (e1, e2) => { if (edgePoint(e1) && edgePoint(e2)) pairs.push([e1, e2]); };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * N1 + i;
    const a = val[k], b = val[k + 1], c = val[k + N1 + 1], d = val[k + N1]; // 左下, 右下, 右上, 左上
    if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) continue;
    const idx = (a > 0) | ((b > 0) << 1) | ((c > 0) << 2) | ((d > 0) << 3);
    if (idx === 0 || idx === 15) continue;
    const B = k * 2, Rt = (k + 1) * 2 + 1, Tp = (k + N1) * 2, L = k * 2 + 1;
    switch (idx) {
      case 1: case 14: add(L, B); break;
      case 2: case 13: add(B, Rt); break;
      case 3: case 12: add(L, Rt); break;
      case 4: case 11: add(Rt, Tp); break;
      case 6: case 9: add(B, Tp); break;
      case 7: case 8: add(L, Tp); break;
      case 5: if ((a + b + c + d) / 4 > 0) { add(B, Rt); add(L, Tp); } else { add(L, B); add(Rt, Tp); } break;
      case 10: if ((a + b + c + d) / 4 > 0) { add(L, B); add(Rt, Tp); } else { add(B, Rt); add(L, Tp); } break;
    }
  }
  // 線分をつないで折れ線にする（各辺は高々2つの線分で共有される）
  const adj = new Map();
  pairs.forEach(([e1, e2], s) => {
    for (const e of [e1, e2]) { const l = adj.get(e); l ? l.push(s) : adj.set(e, [s]); }
  });
  const used = new Uint8Array(pairs.length);
  const walk = (start, from) => {
    const out = [];
    let e = start;
    for (;;) {
      const s = (adj.get(e) || []).find(q => !used[q]);
      if (s === undefined) return out;
      used[s] = 1;
      e = pairs[s][0] === e ? pairs[s][1] : pairs[s][0];
      out.push(e);
      if (e === from) return out;
    }
  };
  const segs = [];
  for (let s = 0; s < pairs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const [e0, e1] = pairs[s];
    const fwd = walk(e1, e0);
    const closed = fwd.length > 0 && fwd[fwd.length - 1] === e0;
    const back = closed ? [] : walk(e0, null);
    const chain = [...back.reverse(), e0, e1, ...fwd];
    const P = [];
    for (const e of chain) { const p = pts.get(e); P.push(p[0], p[1]); }
    if (P.length >= 4) { if (closed) P.closed = true; segs.push(P); }
  }
  return segs;
}

// カーブ上の最も近い点。距離は画面px。hint があればその付近だけ探す（描いている途中で別の枝に飛ばない）
function nearestOnCurve(lx, ly, hint) {
  const segs = rulerCurve(), su = S.ruler.unit * S.view.s;
  const qu = lx / su, qv = -ly / su;
  let best = { d: Infinity };
  const one = (s, i) => {
    const P = segs[s];
    const au = P[i * 2], av = P[i * 2 + 1], du = P[i * 2 + 2] - au, dv = P[i * 2 + 3] - av;
    const l = du * du + dv * dv;
    const t = l ? clamp(((qu - au) * du + (qv - av) * dv) / l, 0, 1) : 0;
    const u = au + du * t, v = av + dv * t, d = Math.hypot(qu - u, qv - v) * su;
    if (d < best.d) best = { d, u, v, s, i };
  };
  if (hint && segs[hint.s] && hint.i < segs[hint.s].length / 2 - 1) {
    const P = segs[hint.s], m = P.length / 2 - 1; // 線分の数
    if (P.closed) for (let k = -150; k <= 150; k++) one(hint.s, (((hint.i + k) % m) + m) % m); // 円などは一周つながる
    else for (let i = Math.max(0, hint.i - 150); i < Math.min(m, hint.i + 150); i++) one(hint.s, i);
  } else segs.forEach((P, s) => { for (let i = 0; i < P.length / 2 - 1; i++) one(s, i); });
  return best;
}
function curveSnapStart(x, y) {
  if (!S.ruler.on || S.ruler.type !== 'fn') return null;
  const { lx, ly } = rulerLocal(x, y), r = nearestOnCurve(lx, ly);
  return r.d <= CURVE_SNAP ? r : null;
}
function curveSnapMove(x, y, hint) {
  const { lx, ly } = rulerLocal(x, y), r = nearestOnCurve(lx, ly, hint);
  if (!(r.d < Infinity)) return null;
  const su = S.ruler.unit * S.view.s, p = rulerToScreen(r.u * su, -r.v * su);
  return { x: p.x, y: p.y, hint: r };
}

/* =========================================================
   描画
   ========================================================= */
function drawKnob(c, x, y) {
  c.beginPath(); c.arc(x, y, 18, 0, Math.PI * 2);
  c.fillStyle = T.knobFill; c.fill();
  c.lineWidth = 1; c.strokeStyle = T.knobLine; c.stroke();
  c.beginPath(); c.arc(x, y, 8, -Math.PI * 0.9, Math.PI * 0.4);
  c.strokeStyle = T.knobIcon; c.lineWidth = 1.6; c.stroke();
  const ex = x + 8 * Math.cos(Math.PI * 0.4), ey = y + 8 * Math.sin(Math.PI * 0.4);
  c.beginPath(); c.moveTo(ex - 4, ey - 1); c.lineTo(ex, ey); c.lineTo(ex + 1, ey - 4); c.stroke();
}
function drawGrip(c, x, y) {
  c.beginPath(); c.arc(x, y, 18, 0, Math.PI * 2);
  c.fillStyle = T.knobFill; c.fill();
  c.lineWidth = 1; c.strokeStyle = T.knobLine; c.stroke();
  c.strokeStyle = T.knobIcon; c.lineWidth = 1.6; c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(x - 9, y); c.lineTo(x + 9, y); c.moveTo(x, y - 9); c.lineTo(x, y + 9);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const tx = x + dx * 9, ty = y + dy * 9;
    c.moveTo(tx - dx * 3 - dy * 3, ty - dy * 3 - dx * 3); c.lineTo(tx, ty); c.lineTo(tx - dx * 3 + dy * 3, ty - dy * 3 + dx * 3);
  }
  c.stroke();
}
function drawPill(c, label, x, y, align, bg = T.pillBg, fg = T.pillText) {
  c.font = '600 13px system-ui, sans-serif';
  const tw = c.measureText(label).width + 16, x0 = align === 'left' ? x : x - tw / 2;
  c.fillStyle = bg;
  c.beginPath(); c.roundRect ? c.roundRect(x0, y - 12, tw, 24, 12) : c.rect(x0, y - 12, tw, 24); c.fill();
  c.fillStyle = fg; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(label, x0 + tw / 2, y + 0.5);
}
// 目盛の間隔：1, 2, 5, 10, 20, 50 … のうち、画面で minPx 以上になる最小のもの
function niceStep(su, minPx) {
  for (let m = 1; ; m *= 10) for (const k of [1, 2, 5]) if (k * m * su >= minPx || m > 1e6) return k * m;
}

function drawFnRuler(c) {
  const R = S.ruler, o = rulerOrigin(), su = R.unit * S.view.s;
  const far = Math.max(Math.hypot(o.x, o.y), Math.hypot(W - o.x, o.y), Math.hypot(o.x, H - o.y), Math.hypot(W - o.x, H - o.y));
  c.save();
  c.translate(o.x, o.y);
  c.rotate(R.a);
  // 座標軸と目盛
  const tick = niceStep(su, 12), lab = niceStep(su, 30), N = Math.ceil(far / su / tick) * tick;
  c.strokeStyle = T.axis; c.lineWidth = 1;
  c.beginPath();
  c.moveTo(-far, 0); c.lineTo(far, 0); c.moveTo(0, -far); c.lineTo(0, far);
  for (let i = -N; i <= N; i += tick) {
    if (!i) continue;
    const big = i % lab === 0 ? 5 : 3;
    c.moveTo(i * su, -big); c.lineTo(i * su, big);
    c.moveTo(-big, -i * su); c.lineTo(big, -i * su);
  }
  c.stroke();
  c.fillStyle = T.rulerText; c.font = '11px system-ui, sans-serif';
  const L = Math.ceil(far / su / lab) * lab, fmt = i => String(i).replace('-', '−');
  c.textAlign = 'center'; c.textBaseline = 'top';
  for (let i = -L; i <= L; i += lab) if (i) c.fillText(fmt(i), i * su, 8);
  c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let i = -L; i <= L; i += lab) if (i) c.fillText(fmt(i), -8, -i * su);
  // カーブ（薄い帯 = 吸着する範囲の目安）
  const segs = rulerCurve();
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const [w, col] of [[CURVE_SNAP, T.curveBand], [2, T.curve]]) {
    c.lineWidth = w; c.strokeStyle = col;
    c.beginPath();
    for (const P of segs) {
      c.moveTo(P[0] * su, -P[1] * su);
      for (let i = 2; i < P.length; i += 2) c.lineTo(P[i] * su, -P[i + 1] * su);
    }
    c.stroke();
  }
  // 原点、移動つまみ（十字矢印）、回転つまみ
  c.beginPath(); c.arc(0, 0, 3, 0, Math.PI * 2); c.fillStyle = T.knobIcon; c.fill();
  drawGrip(c, CURVE_GRIP.x, CURVE_GRIP.y);
  drawKnob(c, CURVE_KNOB.x, CURVE_KNOB.y);
  c.restore();
  const deg = rulerDeg();
  if (compiled.err) drawPill(c, '式エラー：' + compiled.err, o.x + 18, o.y - 28, 'left', 'rgba(220,38,38,.92)', '#ffffff');
  else drawPill(c, prettyExpr(R.expr) + (deg ? `   ${deg}°` : ''), o.x + 18, o.y - 28, 'left');
}

function drawRuler(c) {
  if (S.ruler.type === 'fn') { drawFnRuler(c); return; }
  const r = S.ruler, o = rulerOrigin(), L = Math.hypot(W, H) * 1.5, hw = RULER_W / 2;
  c.save();
  c.translate(o.x, o.y);
  c.rotate(r.a);
  c.fillStyle = T.rulerFill;
  c.fillRect(-L, -hw, L * 2, RULER_W);
  c.strokeStyle = T.rulerLine; c.lineWidth = 1;
  c.beginPath();
  c.moveTo(-L, -hw); c.lineTo(L, -hw); c.moveTo(-L, hw); c.lineTo(L, hw);
  for (let x = -Math.floor(L / 10) * 10; x <= L; x += 10) {
    const t = x % 100 === 0 ? 16 : x % 50 === 0 ? 11 : 6;
    c.moveTo(x, -hw); c.lineTo(x, -hw + t);
    c.moveTo(x, hw); c.lineTo(x, hw - t);
  }
  c.stroke();
  drawKnob(c, RULER_KNOB, 0);
  c.restore();
  drawPill(c, rulerDeg() + '°', o.x, o.y);
}

/* =========================================================
   定規の設定バー
   ========================================================= */
function toggleRuler() {
  const R = S.ruler;
  R.on = !R.on;
  if (R.on) {
    // 画面の中央に置く。方眼があれば原点（直線なら上の縁）を方眼に、1目盛を1マスに合わせる
    R.a = 0;
    placeRulerAtCenter();
    const g = gridStep();
    if (g) R.unit = g;
  }
  $('#btn-ruler').classList.toggle('active', R.on);
  renderRulerOpts();
  renderOverSoon();
}
function placeRulerAtCenter() {
  const g = gridStep(), R = S.ruler;
  setRulerCenter(W / 2, H / 2);
  if (g) {
    R.wy = Math.round(R.wy / g) * g;
    if (R.type === 'fn') R.wx = Math.round(R.wx / g) * g;
  }
}
function saveRulerCfg() {
  const { type, expr, unit } = S.ruler;
  LS.set('ruler2', { type, expr, unit });
}
function unitLabel() {
  const g = gridStep(), u = S.ruler.unit;
  if (!g) return Math.round(u) + 'px';
  const r = u / g;
  return (r >= 1 ? String(+r.toFixed(2)) : { 0.5: '½', 0.25: '¼', 0.125: '⅛' }[r] || String(+r.toFixed(3))) + 'マス';
}

function renderRulerOpts() {
  const box = $('#ruler-opts'), R = S.ruler;
  if (!box) return;
  if (!R.on) { box.innerHTML = ''; return; }
  let h = `<div class="seg" id="ru-type"><button data-v="line" class="${R.type === 'line' ? 'active' : ''}">直線</button><button data-v="fn" class="${R.type === 'fn' ? 'active' : ''}">関数</button></div>`;
  if (R.type === 'fn') {
    h += `<span class="sep"></span>
      <label class="fld">式<input id="ru-expr" placeholder="x^2 や x^2+y^2=9" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"></label>
      <select id="ru-ex" title="例から選ぶ"><option value="">例</option>${FN_EXAMPLES.map(([g, list]) => `<optgroup label="${g}">${list.map(e => `<option value="${e}">${prettyExpr(e)}</option>`).join('')}</optgroup>`).join('')}</select>
      <span class="sep"></span>
      <span class="fld">1目盛<button class="step" data-d="0.5" title="小さく">−</button><b id="ru-unit">${unitLabel()}</b><button class="step" data-d="2" title="大きく">+</button></span>`;
  }
  box.innerHTML = h;

  box.querySelectorAll('#ru-type button').forEach(b => b.onclick = () => {
    if (R.type === b.dataset.v) return;
    R.type = b.dataset.v;
    R.a = 0;
    placeRulerAtCenter();
    saveRulerCfg(); renderRulerOpts(); renderOverSoon();
  });
  if (R.type !== 'fn') return;

  const input = box.querySelector('#ru-expr');
  input.value = R.expr;
  let timer = 0;
  const apply = showError => {
    try {
      parseRulerExpr(input.value);
      input.classList.remove('bad');
      R.expr = input.value.trim(); saveRulerCfg(); renderOverSoon();
    } catch (e) {
      input.classList.add('bad');
      if (showError) toast(e.message);
    }
  };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(() => apply(false), 250); };
  input.onchange = () => { clearTimeout(timer); apply(true); };
  input.onkeydown = e => { if (e.key === 'Enter') input.blur(); };

  const ex = box.querySelector('#ru-ex');
  ex.onchange = () => { if (!ex.value) return; input.value = ex.value; ex.value = ''; apply(true); };

  box.querySelectorAll('.step').forEach(b => b.onclick = () => {
    R.unit = clamp(R.unit * +b.dataset.d, 2, 2048);
    box.querySelector('#ru-unit').textContent = unitLabel();
    saveRulerCfg(); renderOverSoon();
  });
}
