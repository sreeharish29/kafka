'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import { JetBrains_Mono } from 'next/font/google';
import styles from './replay.module.css';
import { BASE_PPS, L, Warp, buildModel, buildWires, layoutFor, parseArticles, parseJsonl, shortUrl, upperBound } from './model';
import type { Article, Crawl, Ev, Job, Wire } from './model';
import { makeSample } from './sample';
import { streamVerify } from './live';

const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

/* ---------------------------------------------------------------- config */

// NEXT_PUBLIC_API_URL may be the base ("http://localhost:8000") or the full stream URL.
// Either way we end up with  <base>/api/verify/stream.
const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000')
  .replace(/\/+$/, '')
  .replace(/\/api\/verify\/stream$/, '')
  .replace(/\/api$/, '');
const API = `${API_BASE}/api/verify/stream`;

const FOLLOW = 0.72; // playhead sits at this fraction of the viewport
const WIRE_GROW = 0.6; // display seconds for a wire to reach its box
const PER_WIRE = 2; // particles per running wire
const FLOW_PERIOD = 1.1; // display seconds for a particle to cross a wire
const SPEEDS = [0.5, 1, 2, 4, 8];

type RunState = 'run' | 'ok' | 'fail';
type Clock = { tau: number; playing: boolean; speed: number; pps: number; scroll: number; viewW: number };
type A3Result = { entities: number; triples: number; modified?: string; skipped?: boolean; reason?: string };

const TONE_HEX: Record<RunState, string> = { run: '#4cc9ff', ok: '#2dff8f', fail: '#ff3b4e' };
const TONE_NAME: Record<RunState, string> = { run: 'cyan', ok: 'green', fail: 'red' };

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const easeInOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
const cssVars = (v: Record<string, string | number>) => v as CSSProperties;

/* =====================================================================
   R3F: wires + particles. Everything lives in one group that the page
   scrolls and scales, so it stays glued to the HTML boxes.
   ===================================================================== */

type LineHandle = {
  visible: boolean;
  geometry: { instanceCount: number };
  material: { opacity: number };
};

type WireItem = { w: Wire; state: RunState };

const WireLine = memo(function WireLine({ w, state, clock }: WireItem & { clock: React.MutableRefObject<Clock> }) {
  const halo = useRef<LineHandle>(null);
  const core = useRef<LineHandle>(null);
  const run = state === 'run';

  const haloColor = useMemo(() => new THREE.Color(TONE_HEX[state]).multiplyScalar(1.6), [state]);
  const coreColor = useMemo(() => {
    const c = new THREE.Color(TONE_HEX[state]);
    // above 1.0 only while running, so settled wires do not bloom
    return run ? c.lerp(new THREE.Color('#ffffff'), 0.35).multiplyScalar(2.4) : c.multiplyScalar(0.85);
  }, [state, run]);

  useFrame(() => {
    const k = clamp((clock.current.tau - w.tauS) / WIRE_GROW, 0, 1);
    const segs = Math.floor(easeInOutSine(k) * (w.world.length - 1));
    const fade = Math.min(1, k * 8);
    const c = core.current;
    if (c) {
      c.visible = segs > 0;
      c.geometry.instanceCount = segs;
      c.material.opacity = (run ? 0.95 : 0.4) * fade;
    }
    const h = halo.current;
    if (h) {
      h.visible = segs > 0;
      h.geometry.instanceCount = segs;
      h.material.opacity = 0.2 * fade;
    }
  });

  return (
    <>
      {run && (
        <Line ref={halo as never} points={w.world} color={haloColor} lineWidth={6} transparent opacity={0} toneMapped={false} depthWrite={false} />
      )}
      <Line ref={core as never} points={w.world} color={coreColor} lineWidth={run ? 1.6 : 1} transparent opacity={0} toneMapped={false} depthWrite={false} />
    </>
  );
});

/** dots running down every wire that is still crawling: one draw call */
function Flow({ items, clock }: { items: WireItem[]; clock: React.MutableRefObject<Clock> }) {
  const MAX = 96;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    g.setDrawRange(0, 0);
    return g;
  }, []);

  const sprite = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d')!;
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }, []);

  const color = useMemo(() => new THREE.Color(TONE_HEX.run).lerp(new THREE.Color('#ffffff'), 0.4).multiplyScalar(2.6), []);

  useFrame(() => {
    const tau = clock.current.tau;
    const pos = geo.attributes.position.array as Float32Array;
    let n = 0;
    for (const { w, state } of itemsRef.current) {
      if (state !== 'run') continue;
      const last = w.world.length - 1;
      const head = easeInOutSine(clamp((tau - w.tauS) / WIRE_GROW, 0, 1));
      for (let p = 0; p < PER_WIRE; p++) {
        const u = ((tau - w.tauS) / FLOW_PERIOD + p / PER_WIRE) % 1;
        if (u > head || n >= MAX) continue;
        const f = u * last;
        const i = Math.floor(f);
        const r = f - i;
        const A = w.world[i];
        const B = w.world[Math.min(last, i + 1)];
        pos[n * 3] = A[0] + (B[0] - A[0]) * r;
        pos[n * 3 + 1] = A[1] + (B[1] - A[1]) * r;
        pos[n * 3 + 2] = 0.5;
        n++;
      }
    }
    geo.setDrawRange(0, n);
    geo.attributes.position.needsUpdate = true;
  });

  return (
    <points geometry={geo} frustumCulled={false}>
      <pointsMaterial map={sprite} color={color} size={7} sizeAttenuation={false} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
    </points>
  );
}

function Scene({
  items,
  clock,
  height,
  drive,
}: {
  items: WireItem[];
  clock: React.MutableRefObject<Clock>;
  height: number;
  drive: React.MutableRefObject<((dt: number) => void) | null>;
}) {
  const group = useRef<THREE.Group>(null);

  // the clock is advanced HERE, so the DOM scroll and the canvas move in the same frame
  useFrame((_, dt) => {
    drive.current?.(dt);
    const c = clock.current;
    group.current?.position.set(-c.scroll - c.viewW / 2, height / 2, 0);
    group.current?.scale.set(c.pps / BASE_PPS, 1, 1);
  });

  return (
    <>
      <color attach="background" args={['#05060a']} />
      <group ref={group}>
        {items.map((it) => (
          <WireLine key={it.w.key} w={it.w} state={it.state} clock={clock} />
        ))}
        <Flow items={items} clock={clock} />
      </group>
      <EffectComposer multisampling={0}>
        <Bloom intensity={1.3} luminanceThreshold={0.25} luminanceSmoothing={0.35} radius={0.7} mipmapBlur />
      </EffectComposer>
    </>
  );
}

/* =====================================================================
   HTML boxes
   ===================================================================== */

const CrawlBox = memo(function CrawlBox({
  c, tauS, tauE, y, state, selected, onSelect,
}: {
  c: Crawl; tauS: number; tauE: number | null; y: number; state: RunState; selected: boolean; onSelect: (url: string) => void;
}) {
  const run = state === 'run';
  const dur = c.tEnd !== null ? c.tEnd - c.tStart : 0;
  return (
    <button
      type="button"
      className={styles.box}
      title={c.url}
      data-kind="crawl"
      data-state={run ? 'charging' : 'lit'}
      data-tone={TONE_NAME[state]}
      data-run={run}
      data-sel={selected}
      style={cssVars({ '--s': tauS, '--d': tauE === null ? 0 : tauE - tauS, '--y': `${y}px`, '--h': `${L.LANE_H}px` })}
      onClick={() => onSelect(c.url)}
    >
      <span className={styles.head}>
        <span>{`w${c.worker} ${run ? 'fetch' : state === 'ok' ? 'complete' : 'failed'}`}</span>
        {run ? <i data-ts={c.tStart}>0.0s</i> : <i>{dur.toFixed(2)}s</i>}
      </span>
      <span className={styles.label}>{shortUrl(c.url)}</span>
      <span className={styles.sub}>{run ? 'crawling' : state === 'ok' ? `${(c.chars ?? 0).toLocaleString()} chars` : c.error ?? 'failed'}</span>
    </button>
  );
});

const JobBox = memo(function JobBox({ j, tauS, tauE, y, state }: { j: Job; tauS: number; tauE: number | null; y: number; state: RunState }) {
  const run = state === 'run';
  return (
    <div
      className={styles.box}
      title={j.error ?? `${j.source}: ${j.query}`}
      data-kind="job"
      data-state={run ? 'charging' : 'lit'}
      data-tone={TONE_NAME[state]}
      data-run={run}
      style={cssVars({ '--s': tauS, '--d': tauE === null ? 0 : tauE - tauS, '--y': `${y}px`, '--h': `${L.ROW_H}px` })}
    >
      <span className={styles.jobTxt}>{`${j.source} · ${j.query}`}</span>
      <span className={styles.jobRes}>
        {run ? <i data-ts={j.tStart}>0.0s</i> : state === 'ok' ? `${j.nUrls} urls, ${j.nNew} new` : 'error'}
      </span>
    </div>
  );
});

/* =====================================================================
   Page
   ===================================================================== */

export default function Page() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [articles, setArticles] = useState<Record<string, Article>>({});
  const [source, setSource] = useState('loading');
  const [skip, setSkip] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [pps, setPps] = useState(90);
  const [playing, setPlaying] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  // live streaming
  const [sentence, setSentence] = useState('');
  const [live, setLive] = useState(false);
  const [stage, setStage] = useState('idle');
  const [result, setResult] = useState<A3Result | null>(null);
  const [runId, setRunId] = useState(0); // bumps only when a NEW dataset starts (not when events are appended)
  const liveRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const clock = useRef<Clock>({ tau: 0, playing: true, speed: 1, pps: 90, scroll: 0, viewW: 1000 });
  const drive = useRef<((dt: number) => void) | null>(null);
  const cursorRef = useRef(0);
  const viewRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrubRef = useRef<HTMLInputElement>(null);
  const scrubbing = useRef(false);
  const prev = useRef<{ warp: Warp; runId: number } | null>(null);

  /* ------------------------------------------------ load data (sample / files) */
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch('/events.jsonl');
        if (!r.ok) throw new Error('no events.jsonl');
        const evs = parseJsonl(await r.text());
        if (!evs.length) throw new Error('empty');
        let arts: Record<string, Article> = {};
        try {
          const a = await fetch('/articles.json');
          if (a.ok) arts = parseArticles(await a.json());
        } catch { /* articles are optional */ }
        if (!dead && !liveRef.current) {
          setEvents(evs);
          setArticles(arts);
          setSource('public/events.jsonl');
          setRunId((r) => r + 1);
        }
      } catch {
        const s = makeSample();
        if (!dead && !liveRef.current) {
          setEvents(s.events);
          setArticles(s.articles);
          setSource('built-in sample');
          setRunId((r) => r + 1);
        }
      }
    })();
    return () => { dead = true; };
  }, []);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    abortRef.current?.abort();
    liveRef.current = false;
    setLive(false);
    let evs: Ev[] | null = null;
    let arts: Record<string, Article> | null = null;
    for (const f of Array.from(files)) {
      const text = await f.text();
      if (f.name.endsWith('.jsonl')) evs = parseJsonl(text);
      else {
        try { arts = parseArticles(JSON.parse(text)); } catch { /* not json */ }
      }
    }
    if (evs?.length) {
      setEvents(evs);
      setArticles(arts ?? {});
      setSource(Array.from(files).map((f) => f.name).join(' + '));
      setSelected(null);
      setResult(null);
      setStage('idle');
      setRunId((r) => r + 1);
    } else if (arts) {
      setArticles(arts);
    }
  };

  /* ------------------------------------------------ live stream */
  const startLive = async (override?: string) => {
    const text = (override ?? sentence).trim();
    if (!text) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const current = () => abortRef.current === ac; // false once a newer run (or Stop) took over

    liveRef.current = true;
    setLive(true);
    setStage('connecting');
    setResult(null);
    setEvents([{ t: 0, type: 'run_start', queries: [text], workers: 6 }]);
    setArticles({});
    setSelected(null);
    setSource('live');
    setRunId((r) => r + 1);

    let base: number | null = null;
    let evBuf: Ev[] = [];
    let artBuf: Record<string, Article> = {};
    let raf = 0;

    // batch to one state update per frame: rebuilding the model per event is wasteful
    const flush = () => {
      raf = 0;
      if (!current()) return;
      const e = evBuf;
      const a = artBuf;
      evBuf = [];
      artBuf = {};
      if (e.length) setEvents((p) => [...p, ...e]);
      if (Object.keys(a).length) setArticles((p) => ({ ...p, ...a }));
    };

    try {
      await streamVerify(
        API,
        text,
        (name, data) => {
          if (!current()) return;

          if (name === 'crawl_event') {
            const ev = data as Ev;
            if (typeof ev.t !== 'number' || typeof ev.type !== 'string') {
              console.warn('dropped crawl_event, bad shape:', ev);
              return;
            }
            if (ev.t > 1e9) {
              // epoch seconds -> seconds since the first crawl event
              base ??= ev.t;
              ev.t = ev.t - base;
            }

            // if crawl_done carries the page text, keep it for the "Selected page" panel
            if (ev.type === 'crawl_done' && typeof ev.url === 'string') {
              const u = ev.url;
              if (typeof ev.text === 'string' || typeof ev.title === 'string') {
                artBuf[u] = {
                  url: u,
                  final_url: typeof ev.final_url === 'string' ? ev.final_url : u,
                  success: Boolean(ev.ok),
                  error: ev.error ? String(ev.error) : null,
                  title: typeof ev.title === 'string' ? ev.title : undefined,
                  text: typeof ev.text === 'string' ? ev.text : '',
                };
              }
            }

            evBuf.push(ev);
            if (!raf) raf = requestAnimationFrame(flush);
          } else if (name === 'a3') {
            const a3 = (data as { a3?: Record<string, unknown> }).a3 ?? {};
            const skipped = Boolean(a3.skipped_crawl);
            setResult({
              entities: Array.isArray(a3.entities) ? a3.entities.length : 0,
              triples: Array.isArray(a3.triples) ? a3.triples.length : 0,
              modified: typeof a3.modified_sentence === 'string' ? a3.modified_sentence : undefined,
              skipped,
              reason: typeof a3.skip_reason === 'string' ? a3.skip_reason : undefined,
            });
            setStage(skipped ? `a3 done (crawl skipped${a3.skip_reason ? `: ${String(a3.skip_reason)}` : ''})` : 'a3');
          } else if (name === 'error') {
            const d = data as { stage?: string; error?: string };
            setStage(`error in ${d.stage ?? '?'}: ${d.error ?? 'unknown'}`);
          } else if (name === 'a1' || name === 'a2' || name === 'session' || name === 'done') {
            setStage(name);
          }
        },
        ac.signal,
      );
    } catch (e) {
      if (current()) {
        if ((e as Error).name === 'AbortError') setStage('stopped');
        else setStage(`error: ${(e as Error).message} (${API})`);
      }
    } finally {
      if (raf) cancelAnimationFrame(raf);
      // only the newest run may touch state
      if (current()) {
        if (evBuf.length) setEvents((p) => [...p, ...evBuf]);
        if (Object.keys(artBuf).length) setArticles((p) => ({ ...p, ...artBuf }));
        liveRef.current = false;
        setLive(false);
      }
    }
  };

  const stopLive = () => abortRef.current?.abort();
  useEffect(() => () => abortRef.current?.abort(), []);

  // auto-start when the previous page passes the sentence: /replay?sentence=...
  // (or via sessionStorage 'sentence'). In React strict mode this runs twice in dev;
  // the second start aborts the first, which is harmless.
  useEffect(() => {
    let q = new URLSearchParams(window.location.search).get('sentence');
    if (!q) {
      try { q = sessionStorage.getItem('sentence'); } catch { /* storage unavailable */ }
    }
    if (q?.trim()) {
      setSentence(q);
      startLive(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------ derived */
  const model = useMemo(() => buildModel(events), [events]);
  const warp = useMemo(() => new Warp(events.map((e) => e.t), skip), [events, skip]);
  const lay = useMemo(() => layoutFor(model.jobs.length, model.workers), [model]);
  const wires = useMemo(() => buildWires(model, warp, lay), [model, warp, lay]);
  const evTau = useMemo(() => events.map((e) => warp.tau(e.t)), [events, warp]);
  const tau0 = warp.TAU[0];
  const endTau = warp.tau(model.tEnd) + 0.8;

  // keep the playhead on the same real moment when skip-gaps is toggled or events are appended;
  // reset only when a new run starts
  useEffect(() => {
    const c = clock.current;
    const p = prev.current;
    if (p && p.runId === runId) c.tau = warp.tau(p.warp.t(c.tau));
    else {
      c.tau = tau0;
      c.playing = true;
      setPlaying(true);
      cursorRef.current = 0;
      setCursor(0);
    }
    prev.current = { warp, runId };
  }, [warp, runId, tau0]);

  useEffect(() => { clock.current.speed = speed; }, [speed]);
  useEffect(() => { clock.current.pps = pps; }, [pps]);

  // runs inside the R3F frame (see Scene)
  useEffect(() => {
    drive.current = (dt: number) => {
      const c = clock.current;
      if (c.playing) {
        c.tau += Math.min(dt, 0.1) * c.speed;
        if (c.tau >= endTau) {
          c.tau = endTau;
          // live: keep waiting at the newest event instead of stopping
          if (!liveRef.current) {
            c.playing = false;
            setPlaying(false);
          }
        }
      }
      const viewW = viewRef.current?.clientWidth ?? 1000;
      const x = c.tau * c.pps;
      c.scroll = Math.max(0, x - viewW * FOLLOW);
      c.viewW = viewW;

      const tReal = warp.t(c.tau);
      const w = worldRef.current;
      if (w) {
        w.style.setProperty('--tau', String(c.tau));
        w.style.transform = `translate3d(${-c.scroll}px,0,0)`;
        w.querySelectorAll<HTMLElement>('i[data-ts]').forEach((el) => {
          el.textContent = `${Math.max(0, tReal - Number(el.dataset.ts)).toFixed(1)}s`;
        });
      }
      if (headRef.current) headRef.current.style.left = `${x - c.scroll}px`;
      if (timeRef.current) timeRef.current.textContent = `${tReal.toFixed(1)}s`;
      if (scrubRef.current && !scrubbing.current) scrubRef.current.value = String(c.tau);

      const cur = upperBound(evTau, c.tau);
      if (cur !== cursorRef.current) {
        cursorRef.current = cur;
        setCursor(cur);
      }
    };
  });

  const togglePlay = () => {
    const c = clock.current;
    if (!c.playing && c.tau >= endTau - 0.01) c.tau = tau0; // replay from the start
    c.playing = !c.playing;
    setPlaying(c.playing);
  };

  const onSelect = useCallback((url: string) => setSelected(url), []);

  /* ------------------------------------------------ what is on screen at `cursor` */
  const view = useMemo(() => {
    const jobs = model.jobs
      .filter((j) => j.iStart < cursor)
      .map((j) => ({
        j,
        state: (j.iEnd !== null && j.iEnd < cursor ? (j.status === 'ok' ? 'ok' : 'fail') : 'run') as RunState,
      }));
    const crawls = model.crawls
      .map((c, idx) => ({ c, idx }))
      .filter(({ c }) => c.iStart < cursor)
      .map(({ c, idx }) => ({
        c,
        w: wires[idx],
        state: (c.iEnd !== null && c.iEnd < cursor ? (c.ok ? 'ok' : 'fail') : 'run') as RunState,
      }));
    const started = crawls.length;
    const queued = model.queued.filter((q) => q.i < cursor).length;
    const running = crawls.filter((x) => x.state === 'run').length;
    const okN = crawls.filter((x) => x.state === 'ok').length;
    const failN = crawls.filter((x) => x.state === 'fail').length;
    const lastDone = [...crawls].reverse().find((x) => x.state !== 'run')?.c;
    return { jobs, crawls, waiting: Math.max(0, queued - started), running, okN, failN, queued, lastDone };
  }, [model, wires, cursor]);

  const items: WireItem[] = useMemo(() => view.crawls.map((x) => ({ w: x.w, state: x.state })), [view.crawls]);

  const detail = (selected ? model.crawls.find((c) => c.url === selected) : undefined) ?? view.lastDone;
  const art = detail ? articles[detail.url] : undefined;
  const log = events.slice(Math.max(0, cursor - 9), cursor).reverse();

  const ticks = useMemo(() => {
    const step = pps >= 110 ? 1 : pps >= 55 ? 2 : 5;
    const out: Array<{ tau: number; label: string }> = [];
    for (let tau = Math.ceil(tau0 / step) * step; tau <= endTau + step; tau += step) {
      out.push({ tau, label: `${warp.t(tau).toFixed(skip ? 1 : 0)}s` });
    }
    return out;
  }, [pps, tau0, endTau, warp, skip]);

  /* ------------------------------------------------ render */
  return (
    <main className={`${styles.page} ${mono.variable}`}>
      {/* ------------------------------------------------ top bar */}
      <header className={styles.bar}>
        <div className={styles.barTop}>
          <h1 className={styles.title}>Search and fetch replay</h1>
          <span className={styles.src}>{source}</span>
          {stage !== 'idle' && (
            <span className={styles.src} data-live={live} title={stage}>
              {live ? '● ' : ''}{stage}
            </span>
          )}

          <div className={styles.controls}>
            <input
              className={styles.input}
              value={sentence}
              onChange={(e) => setSentence(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !live) startLive();
              }}
              placeholder="sentence to verify"
              aria-label="Sentence to verify"
              disabled={live}
            />
            <button
              type="button"
              className={styles.btn}
              aria-pressed={live}
              disabled={!live && !sentence.trim()}
              onClick={() => (live ? stopLive() : startLive())}
            >
              {live ? 'Stop' : 'Verify live'}
            </button>

            <button type="button" className={styles.btn} onClick={togglePlay}>
              {playing ? 'Pause' : clock.current.tau >= endTau - 0.01 ? 'Replay' : 'Play'}
            </button>
            <span className={styles.seg} role="group" aria-label="Speed">
              {SPEEDS.map((s) => (
                <button key={s} type="button" className={styles.segBtn} aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                  {s}x
                </button>
              ))}
            </span>
            <button type="button" className={styles.btn} aria-pressed={skip} onClick={() => setSkip((v) => !v)}>
              Skip gaps
            </button>
            <label className={styles.zoom}>
              Zoom
              <input type="range" min={40} max={220} value={pps} onChange={(e) => setPps(Number(e.target.value))} />
            </label>
            <label className={styles.btn}>
              Load files
              <input type="file" multiple accept=".jsonl,.json" hidden onChange={(e) => onFiles(e.target.files)} />
            </label>
          </div>
        </div>

        <div className={styles.barBottom}>
          <span className={styles.clockTxt}>
            t = <b ref={timeRef}>0.0s</b> / {model.tEnd.toFixed(1)}s
          </span>
          <input
            ref={scrubRef}
            className={styles.scrub}
            type="range"
            min={tau0}
            max={endTau}
            step="any"
            aria-label="Seek"
            onPointerDown={() => (scrubbing.current = true)}
            onPointerUp={() => (scrubbing.current = false)}
            onChange={(e) => (clock.current.tau = Number(e.target.value))}
          />
          <span className={styles.stats}>
            <span>queued {view.waiting}</span>
            <span data-k="run">crawling {view.running}/{model.workers}</span>
            <span data-k="ok">done {view.okN}</span>
            <span data-k="fail">failed {view.failN}</span>
          </span>
        </div>
      </header>

      {/* ------------------------------------------------ timeline */}
      <section className={styles.timeline}>
        <div className={styles.inner} style={{ height: lay.height }}>
          <div className={styles.canvasLayer} style={{ left: L.GUTTER_W }}>
            <Canvas
              orthographic
              flat
              dpr={[1, 2]}
              camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 500 }}
              gl={{ antialias: false, powerPreference: 'high-performance' }}
              resize={{ offsetSize: true }}
            >
              <Scene items={items} clock={clock} height={lay.height} drive={drive} />
            </Canvas>
          </div>

          {/* row guides and labels */}
          {model.jobs.map((j) => (
            <div key={j.id} className={styles.rowBg} style={{ top: lay.jobY(j.row), height: L.ROW_H }} />
          ))}
          {Array.from({ length: model.workers }, (_, w) => (
            <div key={w} className={styles.laneBg} style={{ top: lay.laneY(w), height: L.LANE_H }} />
          ))}
          <div className={styles.gutter} style={{ width: L.GUTTER_W }}>
            {model.jobs.map((j) => (
              <span key={j.id} className={styles.gl} style={{ top: lay.jobY(j.row), height: L.ROW_H }}>{j.id}</span>
            ))}
            {Array.from({ length: model.workers }, (_, w) => (
              <span key={w} className={styles.gl} style={{ top: lay.laneY(w), height: L.LANE_H }}>worker {w}</span>
            ))}
          </div>

          <div ref={viewRef} className={styles.view} style={{ left: L.GUTTER_W }}>
            <div ref={worldRef} className={styles.world} style={cssVars({ '--pps': pps, height: lay.height })}>
              {ticks.map((t) => (
                <i key={t.tau} className={styles.tick} style={cssVars({ '--s': t.tau })}>
                  <span>{t.label}</span>
                </i>
              ))}
              {warp.gaps.map((g) => (
                <div key={g.from} className={styles.gap} style={cssVars({ '--s': g.from, '--d': g.to - g.from })}>
                  <span>{`${g.secs.toFixed(1)}s skipped`}</span>
                </div>
              ))}
              {view.jobs.map(({ j, state }) => (
                <JobBox
                  key={j.id}
                  j={j}
                  state={state}
                  tauS={warp.tau(j.tStart)}
                  tauE={j.tEnd === null ? null : warp.tau(j.tEnd)}
                  y={lay.jobY(j.row)}
                />
              ))}
              {view.crawls.map(({ c, w, state }) => (
                <CrawlBox
                  key={c.url}
                  c={c}
                  state={state}
                  tauS={w.tauS}
                  tauE={w.tauE}
                  y={lay.laneY(c.worker)}
                  selected={detail?.url === c.url}
                  onSelect={onSelect}
                />
              ))}
            </div>
            <div ref={headRef} className={styles.playhead} />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ drawer */}
      <footer className={styles.drawer}>
        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Event stream</h2>
          <ul className={styles.log}>
            {log.map((e, i) => (
              <li key={`${cursor}-${i}`} data-type={e.type}>
                <span className={styles.logT}>{e.t.toFixed(2)}</span>
                <span className={styles.logType}>{e.type}</span>
                <span className={styles.logArg}>
                  {typeof e.url === 'string' ? shortUrl(e.url, 46) : typeof e.job === 'string' ? e.job : ''}
                  {e.type === 'crawl_done' ? (e.ok ? ' ok' : ' failed') : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Selected page</h2>
          {detail ? (
            <div className={styles.detail}>
              <p className={styles.detailTitle}>{art?.title || shortUrl(detail.url)}</p>
              <p className={styles.detailUrl}>{art?.final_url || detail.url}</p>
              <p className={styles.detailMeta}>
                <span data-k={detail.tEnd === null ? 'run' : detail.ok ? 'ok' : 'fail'}>
                  {detail.tEnd === null ? 'crawling' : detail.ok ? 'complete' : 'failed'}
                </span>
                <span>worker {detail.worker}</span>
                {detail.tEnd !== null && <span>{(detail.tEnd - detail.tStart).toFixed(2)}s</span>}
                {detail.ok && <span>{(detail.chars ?? 0).toLocaleString()} chars</span>}
                {art?.found_by?.length ? <span>found by {art.found_by.join(', ')}</span> : null}
              </p>
              {detail.error ? <p className={styles.detailErr}>{detail.error}</p> : null}
              <p className={styles.preview}>{art?.text ? art.text.slice(0, 420) : art ? 'No text was extracted.' : 'No page text for this URL.'}</p>
            </div>
          ) : (
            <p className={styles.empty}>Click a box to inspect that page.</p>
          )}
        </div>

        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Run</h2>
          <dl className={styles.run}>
            <dt>Queries</dt>
            <dd>{model.queries.length ? model.queries.join(' | ') : 'none logged'}</dd>
            <dt>Search jobs</dt>
            <dd>{model.jobs.length}</dd>
            <dt>URLs queued</dt>
            <dd>{view.queued} of {model.queued.length}</dd>
            <dt>Gaps skipped</dt>
            <dd>{skip ? `${warp.gaps.length} (${warp.gaps.reduce((s, g) => s + g.secs, 0).toFixed(1)}s)` : 'off'}</dd>
            {result && (
              <>
                <dt>A3 result</dt>
                <dd title={result.modified ?? ''}>
                  {result.skipped ? `skipped${result.reason ? `: ${result.reason}` : ''}` : `${result.entities} entities, ${result.triples} triples`}
                </dd>
              </>
            )}
          </dl>
        </div>
      </footer>
    </main>
  );
}