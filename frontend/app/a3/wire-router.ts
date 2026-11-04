/* =====================================================================
   wire-router.ts — wire routing

   1. Rasterise the board into RES px cells. Every box (plus CLEAR px
      margin) is blocked.
   2. For every (source side x destination side) pair run A* over
      (cell, heading) states. Cost = steps + a penalty for each turn +
      a small penalty near boxes/edges, which pulls wires to the middle
      of the channels. The cheapest pair wins, so the destination side
      chosen is the closest one reachable without crossing any box.
   3. The cell path is collapsed to its corners and every corner is
      rounded with a quadratic curve, so there are no 90 degree turns.
   4. The curve is resampled at a constant spacing and can be offset
      sideways to make a bundle of parallel strands.
   ===================================================================== */

import { BOARD_H, BOARD_W, CLEAR, OUT, RES, SIDES, STUB } from './grid';
import type { Pt, Rect, Side } from './grid';

const GW = Math.ceil(BOARD_W / RES);
const GH = Math.ceil(BOARD_H / RES);

// headings: 0 up, 1 right, 2 down, 3 left
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const SIDE_DIR: Record<Side, number> = { top: 0, right: 1, bottom: 2, left: 3 };

const TURN_COST = 6; // one turn costs as much as 6 straight cells
const PROX_RANGE = 4; // cells; wires feel boxes/edges within this range
const PROX_WEIGHT = 0.35;
const CORNER_RADIUS = 44; // px, upper bound for rounded corners
const SAMPLE_STEP = 3; // px between samples on the final curve

export type Route = {
  points: Pt[]; // dense, smooth, evenly spaced
  length: number; // px
  fromSide: Side;
  toSide: Side;
};

/* ------------------------------------------------------------ grid ---- */

function buildGrid(rects: Rect[]) {
  const blocked = new Uint8Array(GW * GH);

  for (const r of rects) {
    const x0 = r.x - CLEAR;
    const x1 = r.x + r.w + CLEAR;
    const y0 = r.y - CLEAR;
    const y1 = r.y + r.h + CLEAR;
    for (let cy = Math.max(0, Math.floor(y0 / RES)); cy <= Math.min(GH - 1, Math.floor(y1 / RES)); cy++) {
      for (let cx = Math.max(0, Math.floor(x0 / RES)); cx <= Math.min(GW - 1, Math.floor(x1 / RES)); cx++) {
        const px = (cx + 0.5) * RES;
        const py = (cy + 0.5) * RES;
        if (px > x0 && px < x1 && py > y0 && py < y1) blocked[cy * GW + cx] = 1;
      }
    }
  }

  // distance (in cells) to the nearest blocked cell or board edge
  const dist = new Int16Array(GW * GH).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < blocked.length; i++) {
    if (blocked[i]) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let cy = 0; cy < GH; cy++) {
    for (let cx = 0; cx < GW; cx++) {
      const i = cy * GW + cx;
      if (!blocked[i] && (cx === 0 || cy === 0 || cx === GW - 1 || cy === GH - 1) && dist[i] < 0) {
        dist[i] = 1;
        queue.push(i);
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const d = dist[i];
    if (d >= PROX_RANGE) continue;
    const cx = i % GW;
    const cy = (i / GW) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = cx + DX[k];
      const ny = cy + DY[k];
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const ni = ny * GW + nx;
      if (dist[ni] < 0) {
        dist[ni] = d + 1;
        queue.push(ni);
      }
    }
  }

  const prox = new Float32Array(GW * GH);
  for (let i = 0; i < prox.length; i++) {
    const d = dist[i];
    prox[i] = d >= 0 && d < PROX_RANGE ? (PROX_RANGE - d) * PROX_WEIGHT : 0;
  }
  return { blocked, prox };
}

/* ----------------------------------------------------------- ports ---- */

type Port = { side: Side; cx: number; cy: number; port: Pt; dir: number };

/** The point on a box edge where a wire attaches + the routing cell just outside it. */
function portOf(rect: Rect, side: Side): Port {
  const mx = rect.x + rect.w / 2;
  const my = rect.y + rect.h / 2;
  const edge: Pt =
    side === 'top' ? { x: mx, y: rect.y }
    : side === 'bottom' ? { x: mx, y: rect.y + rect.h }
    : side === 'left' ? { x: rect.x, y: my }
    : { x: rect.x + rect.w, y: my };

  const o = OUT[side];
  const cx = Math.floor((edge.x + o.dx * STUB) / RES);
  const cy = Math.floor((edge.y + o.dy * STUB) / RES);
  const cc = { x: (cx + 0.5) * RES, y: (cy + 0.5) * RES };

  // snap the sideways coordinate to the routing cell so the first run is perfectly straight
  const port: Pt = o.dx !== 0 ? { x: edge.x, y: cc.y } : { x: cc.x, y: edge.y };
  return { side, cx, cy, port, dir: SIDE_DIR[side] };
}

/* ------------------------------------------------------------ A* ----- */

class MinHeap {
  private f: number[] = [];
  private s: number[] = [];
  get size() {
    return this.f.length;
  }
  push(f: number, s: number) {
    let i = this.f.length;
    this.f.push(f);
    this.s.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      [this.f[p], this.f[i]] = [this.f[i], this.f[p]];
      [this.s[p], this.s[i]] = [this.s[i], this.s[p]];
      i = p;
    }
  }
  pop(): number {
    const top = this.s[0];
    const lf = this.f.pop()!;
    const ls = this.s.pop()!;
    if (this.f.length) {
      this.f[0] = lf;
      this.s[0] = ls;
      let i = 0;
      const n = this.f.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.f[l] < this.f[m]) m = l;
        if (r < n && this.f[r] < this.f[m]) m = r;
        if (m === i) break;
        [this.f[m], this.f[i]] = [this.f[i], this.f[m]];
        [this.s[m], this.s[i]] = [this.s[i], this.s[m]];
        i = m;
      }
    }
    return top;
  }
}

function astar(blocked: Uint8Array, prox: Float32Array, a: Port, b: Port) {
  if (blocked[a.cy * GW + a.cx] || blocked[b.cy * GW + b.cx]) return null;

  const goalDir = (b.dir + 2) & 3; // arrive heading INTO the destination box
  const g = new Float32Array(GW * GH * 4).fill(Infinity);
  const parent = new Int32Array(GW * GH * 4).fill(-1);
  const closed = new Uint8Array(GW * GH * 4);
  const heap = new MinHeap();

  const s0 = (a.cy * GW + a.cx) * 4 + a.dir; // start heading out of the source box
  g[s0] = 0;
  heap.push(Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy), s0);

  while (heap.size) {
    const s = heap.pop();
    if (closed[s]) continue;
    closed[s] = 1;

    const d = s & 3;
    const cell = s >> 2;
    const cx = cell % GW;
    const cy = (cell / GW) | 0;

    if (cx === b.cx && cy === b.cy) {
      const cells: Pt[] = [];
      for (let k = s; k !== -1; k = parent[k]) {
        const c = k >> 2;
        cells.push({ x: ((c % GW) + 0.5) * RES, y: (((c / GW) | 0) + 0.5) * RES });
      }
      cells.reverse();
      return { cost: g[s], cells };
    }

    for (let nd = 0; nd < 4; nd++) {
      if (nd === ((d + 2) & 3)) continue; // no U-turns
      const nx = cx + DX[nd];
      const ny = cy + DY[nd];
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const nc = ny * GW + nx;
      if (blocked[nc]) continue;

      let c = 1 + prox[nc];
      if (nd !== d) c += TURN_COST;
      if (nx === b.cx && ny === b.cy && nd !== goalDir) c += TURN_COST;

      const ns = nc * 4 + nd;
      const ng = g[s] + c;
      if (ng < g[ns]) {
        g[ns] = ng;
        parent[ns] = s;
        heap.push(ng + Math.abs(nx - b.cx) + Math.abs(ny - b.cy), ns);
      }
    }
  }
  return null;
}

/* --------------------------------------------------------- geometry --- */

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Drop points that sit on a straight line between their neighbours. */
function compress(pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Replace every corner with a quadratic curve (corner = control point). */
function roundCorners(pts: Pt[], radius: number): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [pts[0]];
  const last = pts.length - 1;

  for (let i = 1; i < last; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const l1 = dist(a, b);
    const l2 = dist(b, c);
    // a neighbouring corner may use half of the shared segment; the ends can use all of it
    const room1 = i - 1 === 0 ? l1 : l1 / 2;
    const room2 = i + 1 === last ? l2 : l2 / 2;
    const t = Math.min(radius, room1, room2);

    const p1 = { x: b.x + ((a.x - b.x) / l1) * t, y: b.y + ((a.y - b.y) / l1) * t };
    const p2 = { x: b.x + ((c.x - b.x) / l2) * t, y: b.y + ((c.y - b.y) / l2) * t };

    const n = 16;
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * (1 - u) * u;
      const w2 = u * u;
      out.push({ x: w0 * p1.x + w1 * b.x + w2 * p2.x, y: w0 * p1.y + w1 * b.y + w2 * p2.y });
    }
  }
  out.push(pts[last]);
  return out;
}

/** Evenly spaced samples along a polyline. */
function resample(pts: Pt[], step: number): { points: Pt[]; length: number } {
  const clean: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) if (dist(pts[i], clean[clean.length - 1]) > 1e-6) clean.push(pts[i]);

  const cum = [0];
  for (let i = 1; i < clean.length; i++) cum.push(cum[i - 1] + dist(clean[i - 1], clean[i]));
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.round(total / step));

  const points: Pt[] = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const target = (k / n) * total;
    while (j < cum.length - 1 && cum[j] < target) j++;
    const seg = cum[j] - cum[j - 1] || 1;
    const u = (target - cum[j - 1]) / seg;
    points.push({
      x: clean[j - 1].x + (clean[j].x - clean[j - 1].x) * u,
      y: clean[j - 1].y + (clean[j].y - clean[j - 1].y) * u,
    });
  }
  return { points, length: total };
}

/* ------------------------------------------------------------ public -- */

/**
 * Route a wire from one box to another without crossing any box.
 * `all` must contain every box rectangle (including `from` and `to`).
 */
export function routeWire(from: Rect, to: Rect, all: Rect[]): Route | null {
  const { blocked, prox } = buildGrid(all);

  let best: { cost: number; cells: Pt[]; a: Port; b: Port } | null = null;
  for (const sa of SIDES) {
    const a = portOf(from, sa);
    for (const sb of SIDES) {
      const b = portOf(to, sb);
      const r = astar(blocked, prox, a, b);
      if (r && (!best || r.cost < best.cost)) best = { ...r, a, b };
    }
  }
  if (!best) return null;

  const corners = compress([best.a.port, ...best.cells, best.b.port]);
  const { points, length } = resample(roundCorners(corners, CORNER_RADIUS), SAMPLE_STEP);
  return { points, length, fromSide: best.a.side, toSide: best.b.side };
}

/** Shift a smooth path sideways (perpendicular to its direction). */
export function offsetPath(pts: Pt[], offset: number): Pt[] {
  if (offset === 0) return pts;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    return { x: p.x - ty * offset, y: p.y + tx * offset };
  });
}
