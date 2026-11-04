/* =====================================================================
   model.ts — parse the log, build the timeline model, warp time, route wires

   Everything here is pure. The whole run is loaded up front, so the page
   can derive the picture for ANY moment from (model, cursor), which is
   what makes seeking, speed changes and skip-gaps cheap and exact.
   ===================================================================== */

export type Ev = { t: number; type: string; [k: string]: unknown };

export type Article = {
  url: string;
  final_url?: string;
  success?: boolean;
  error?: string | null;
  title?: string;
  text?: string;
  found_by?: string[];
};

/* ----------------------------------------------------------- parsing */

export function parseJsonl(text: string): Ev[] {
  const out: Ev[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      if (ev && typeof ev.t === 'number' && typeof ev.type === 'string') out.push(ev as Ev);
    } catch {
      /* truncated or partial line: skip it */
    }
  }
  return out.sort((a, b) => a.t - b.t); // stable: ties keep file order
}

export function parseArticles(json: unknown): Record<string, Article> {
  if (Array.isArray(json)) {
    return Object.fromEntries(json.filter((a) => a && a.url).map((a: Article) => [a.url, a]));
  }
  return (json && typeof json === 'object' ? json : {}) as Record<string, Article>;
}

/* ------------------------------------------------------------- model */

export type Job = {
  id: string;
  source: string;
  query: string;
  row: number;
  iStart: number; // event index
  iEnd: number | null;
  tStart: number; // real seconds
  tEnd: number | null;
  status: 'run' | 'ok' | 'err';
  nUrls?: number;
  nNew?: number;
  error?: string;
};

export type Crawl = {
  url: string;
  worker: number;
  job: string | null; // which search job queued this url
  tQueued: number | null;
  iStart: number;
  iEnd: number | null;
  tStart: number;
  tEnd: number | null;
  ok?: boolean;
  chars?: number;
  error?: string | null;
};

export type Queued = { url: string; i: number; t: number; job: string };

export type Model = {
  events: Ev[];
  workers: number;
  queries: string[];
  jobs: Job[];
  crawls: Crawl[];
  queued: Queued[];
  t0: number;
  tEnd: number;
};

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export function buildModel(events: Ev[]): Model {
  const jobs = new Map<string, Job>();
  const jobList: Job[] = [];
  const queuedMap = new Map<string, Queued>();
  const queued: Queued[] = [];
  const open = new Map<string, Crawl>();
  const crawls: Crawl[] = [];
  let workers = 6;
  let queries: string[] = [];

  events.forEach((ev, i) => {
    switch (ev.type) {
      case 'run_start':
        workers = Number(ev.workers) || 6;
        queries = Array.isArray(ev.queries) ? (ev.queries as string[]) : [];
        break;
      case 'search_start': {
        const j: Job = {
          id: str(ev.job),
          source: str(ev.source),
          query: str(ev.query),
          row: jobList.length,
          iStart: i,
          iEnd: null,
          tStart: ev.t,
          tEnd: null,
          status: 'run',
        };
        jobs.set(j.id, j);
        jobList.push(j);
        break;
      }
      case 'search_done':
      case 'search_error': {
        const j = jobs.get(str(ev.job));
        if (!j) break;
        j.iEnd = i;
        j.tEnd = ev.t;
        if (ev.type === 'search_done') {
          j.status = 'ok';
          j.nUrls = Number(ev.n_urls) || 0;
          j.nNew = Number(ev.n_new) || 0;
        } else {
          j.status = 'err';
          j.error = str(ev.error);
        }
        break;
      }
      case 'url_queued': {
        const url = str(ev.url);
        if (!queuedMap.has(url)) {
          const q = { url, i, t: ev.t, job: str(ev.job) };
          queuedMap.set(url, q);
          queued.push(q);
        }
        break;
      }
      case 'crawl_start': {
        const url = str(ev.url);
        const q = queuedMap.get(url);
        const c: Crawl = {
          url,
          worker: Number(ev.worker) || 0,
          job: q?.job ?? null,
          tQueued: q?.t ?? null,
          iStart: i,
          iEnd: null,
          tStart: ev.t,
          tEnd: null,
        };
        crawls.push(c);
        open.set(url, c);
        workers = Math.max(workers, c.worker + 1);
        break;
      }
      case 'crawl_done': {
        const c = open.get(str(ev.url));
        if (!c) break;
        c.iEnd = i;
        c.tEnd = ev.t;
        c.ok = Boolean(ev.ok);
        c.chars = Number(ev.chars) || 0;
        c.error = ev.error ? str(ev.error) : null;
        open.delete(c.url);
        break;
      }
    }
  });

  return {
    events,
    workers,
    queries,
    jobs: jobList,
    crawls,
    queued,
    t0: events[0]?.t ?? 0,
    tEnd: events[events.length - 1]?.t ?? 0,
  };
}

/* -------------------------------------------------------- time warp ---
   tau is the time the screen uses. With skip off, tau === t.
   With skip on, any stretch with no events longer than maxGap is
   squeezed to `keep` seconds and reported in `gaps` for the markers.   */

export type Gap = { from: number; to: number; secs: number }; // from/to in tau

export class Warp {
  readonly T: number[];
  readonly TAU: number[];
  readonly gaps: Gap[] = [];

  constructor(times: number[], skip: boolean, maxGap = 1.5, keep = 0.5) {
    const T = [...new Set(times)].sort((a, b) => a - b);
    if (!T.length) T.push(0);
    const TAU = [T[0]];
    for (let i = 1; i < T.length; i++) {
      const dt = T[i] - T[i - 1];
      const squeeze = skip && dt > maxGap;
      TAU.push(TAU[i - 1] + (squeeze ? keep : dt));
      if (squeeze) this.gaps.push({ from: TAU[i - 1], to: TAU[i], secs: dt });
    }
    this.T = T;
    this.TAU = TAU;
  }

  private map(x: number, from: number[], to: number[]) {
    const n = from.length;
    if (x <= from[0]) return to[0] + (x - from[0]);
    if (x >= from[n - 1]) return to[n - 1] + (x - from[n - 1]);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (from[mid] <= x) lo = mid;
      else hi = mid;
    }
    return to[lo] + ((x - from[lo]) / (from[hi] - from[lo])) * (to[hi] - to[lo]);
  }

  tau(t: number) {
    return this.map(t, this.T, this.TAU);
  }
  t(tau: number) {
    return this.map(tau, this.TAU, this.T);
  }
}

/* ------------------------------------------------------------ layout */

export const BASE_PPS = 100; // wires are built at this scale, the canvas group is scaled by pps / BASE_PPS

export const L = {
  AXIS_H: 30,
  ROW_H: 26,
  ROW_GAP: 4,
  LANE_H: 56,
  LANE_GAP: 8,
  SECTION_GAP: 20,
  GUTTER_W: 104,
};

export function layoutFor(nJobs: number, nWorkers: number) {
  const searchTop = L.AXIS_H + 10;
  const searchH = Math.max(1, nJobs) * (L.ROW_H + L.ROW_GAP);
  const lanesTop = searchTop + searchH + L.SECTION_GAP;
  return {
    searchTop,
    lanesTop,
    height: lanesTop + nWorkers * (L.LANE_H + L.LANE_GAP) + 8,
    jobY: (row: number) => searchTop + row * (L.ROW_H + L.ROW_GAP),
    laneY: (w: number) => lanesTop + w * (L.LANE_H + L.LANE_GAP),
  };
}
export type Layout = ReturnType<typeof layoutFor>;

/* ------------------------------------------------------------- wires */

export type Wire = {
  key: string;
  world: Array<[number, number, number]>; // x = tau * BASE_PPS, y = -(px from top)
  tauS: number;
  tauE: number | null;
};

const SAMPLES = 48;

/** job bar -> crawl box. Leaves the bar going down, enters the box from the left. */
export function buildWires(m: Model, warp: Warp, lay: Layout): Wire[] {
  const jobById = new Map(m.jobs.map((j) => [j.id, j]));

  return m.crawls.map((c) => {
    const x1 = warp.tau(c.tStart) * BASE_PPS;
    const y1 = lay.laneY(c.worker) + L.LANE_H / 2;

    const j = c.job ? jobById.get(c.job) : undefined;
    const y0 = j ? lay.jobY(j.row) + L.ROW_H / 2 : lay.searchTop;
    const jx0 = j ? warp.tau(j.tStart) * BASE_PPS : x1;
    const jx1 = j ? warp.tau(j.tEnd ?? m.tEnd) * BASE_PPS : x1;

    // each worker leaves the bar a bit further left, so wires that start together fan out
    const lead = 24 + 18 * c.worker;
    const x0 = Math.min(Math.max(Math.min(x1, jx1) - lead, jx0), jx1);

    const p1 = { x: x0, y: y0 + (y1 - y0) * 0.6 };
    const p2 = { x: x1 - Math.min(90, (x1 - x0) * 0.5), y: y1 };

    const world: Wire['world'] = [];
    for (let k = 0; k <= SAMPLES; k++) {
      const t = k / SAMPLES;
      const u = 1 - t;
      const w0 = u * u * u;
      const w1 = 3 * u * u * t;
      const w2 = 3 * u * t * t;
      const w3 = t * t * t;
      world.push([
        w0 * x0 + w1 * p1.x + w2 * p2.x + w3 * x1,
        -(w0 * y0 + w1 * p1.y + w2 * p2.y + w3 * y1),
        0,
      ]);
    }
    return {
      key: c.url,
      world,
      tauS: warp.tau(c.tStart),
      tauE: c.tEnd === null ? null : warp.tau(c.tEnd),
    };
  });
}

/* ------------------------------------------------------------ helpers */

export function shortUrl(u: string, max = 60) {
  try {
    const x = new URL(u);
    const s = x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '');
    return s.length > max ? `${s.slice(0, Math.ceil(max * 0.55))}…${s.slice(-Math.floor(max * 0.4))}` : s;
  } catch {
    return u;
  }
}

/** number of items in a sorted array that are <= x */
export function upperBound(arr: number[], x: number) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
