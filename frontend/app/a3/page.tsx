'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import { JetBrains_Mono } from 'next/font/google';
import styles from './a3.module.css';
import {
  BOARD_H,
  BOARD_W,
  BOX_H,
  BOX_W,
  BOXES,
  LANES_X,
  LANES_Y,
  RES,
  SLOTS,
  boxRect,
  checkGridAlignment,
  toWorld,
} from './grid';
import type { Side } from './grid';
import { offsetPath, routeWire } from './wire-router';

const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

/* ---------------------------------------------------------------- config */

const CHARGE_MS = 750; // box edge lighting up
const WIRE_SPEED = 0.8; // px per ms while a wire grows
const WIRE_MIN_MS = 700;
const WIRE_MAX_MS = 2200;

// a bundle of parallel strands; offsets in px, perpendicular to the wire
const STRANDS = [
  { offset: -9, width: 2, bright: 0.7 },
  { offset: 0, width: 3, bright: 1 },
  { offset: 9, width: 2, bright: 0.7 },
];

const GREEN = new THREE.Color('#2dff8f');
const rects = BOXES.map(boxRect);
const boxById = new Map(BOXES.map((b) => [b.id, b]));

type NodeState = 'idle' | 'charging' | 'lit';
type WorldPts = Array<[number, number, number]>;

type WireData = {
  id: string;
  from: string;
  to: string;
  fromSide: Side;
  toSide: Side;
  strands: WorldPts[];
  t0: number;
  dur: number;
  arrived: boolean;
};

const SIDE_LETTER: Record<Side, string> = { top: 't', right: 'r', bottom: 'b', left: 'l' };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const easeInOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
const cssVars = (v: Record<string, string | number>) => v as CSSProperties;

/* =====================================================================
   R3F: glowing wires that grow from source to destination
   ===================================================================== */

type LineHandle = {
  visible: boolean;
  geometry: { instanceCount: number };
  material: { opacity: number };
};

function StrandLine({
  pts,
  t0,
  dur,
  width,
  bright,
}: {
  pts: WorldPts;
  t0: number;
  dur: number;
  width: number;
  bright: number;
}) {
  const halo = useRef<LineHandle>(null);
  const core = useRef<LineHandle>(null);

  // colours above 1.0 so Bloom picks them up
  const haloColor = useMemo(() => GREEN.clone().multiplyScalar(1.6), []);
  const coreColor = useMemo(() => GREEN.clone().lerp(new THREE.Color('#ffffff'), 0.35).multiplyScalar(2.4), []);

  useFrame(() => {
    const k = clamp((performance.now() - t0) / dur, 0, 1);
    const segs = Math.floor(easeInOutSine(k) * (pts.length - 1));
    const fade = Math.min(1, k * 12);

    const h = halo.current;
    if (h) {
      h.visible = segs > 0;
      h.geometry.instanceCount = segs;
      h.material.opacity = 0.2 * fade * bright;
    }
    const c = core.current;
    if (c) {
      c.visible = segs > 0;
      c.geometry.instanceCount = segs;
      c.material.opacity = 0.95 * fade * bright;
    }
  });

  return (
    <>
      <Line
        ref={halo as never}
        points={pts}
        color={haloColor}
        lineWidth={width * 3.2}
        transparent
        opacity={0}
        toneMapped={false}
        depthWrite={false}
      />
      <Line
        ref={core as never}
        points={pts}
        color={coreColor}
        lineWidth={width}
        transparent
        opacity={0}
        toneMapped={false}
        depthWrite={false}
      />
    </>
  );
}

function Scene({ wires }: { wires: WireData[] }) {
  return (
    <>
      <color attach="background" args={['#04060a']} />
      {wires.map((w) =>
        w.strands.map((pts, i) => (
          <StrandLine
            key={`${w.id}-${i}`}
            pts={pts}
            t0={w.t0}
            dur={w.dur}
            width={STRANDS[i].width}
            bright={STRANDS[i].bright}
          />
        )),
      )}
      <EffectComposer multisampling={0}>
        <Bloom intensity={1.5} luminanceThreshold={0.2} luminanceSmoothing={0.4} radius={0.75} mipmapBlur />
      </EffectComposer>
    </>
  );
}

/* =====================================================================
   Page
   ===================================================================== */

function useFit() {
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const on = () =>
      setFit(Math.min(1, (window.innerWidth - 32) / BOARD_W, (window.innerHeight - 32) / BOARD_H));
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return fit;
}

export default function Page() {
  const [source, setSource] = useState<string | null>(null);
  const [wires, setWires] = useState<WireData[]>([]);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({});
  const [showGrid, setShowGrid] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const timers = useRef<number[]>([]);
  const fit = useFit();

  useEffect(() => {
    checkGridAlignment();
    return () => timers.current.forEach((id) => window.clearTimeout(id));
  }, []);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const setNode = (id: string, s: NodeState) => setNodeStates((m) => ({ ...m, [id]: s }));

  /** edge ring draws around the box, then it settles into the lit state */
  const lightUp = (id: string) => {
    setNode(id, 'charging');
    later(() => setNodeStates((m) => (m[id] === 'charging' ? { ...m, [id]: 'lit' } : m)), CHARGE_MS);
  };

  const hasWires = (id: string) => wires.some((w) => w.from === id || w.to === id);

  const flash = (text: string) => {
    setMessage(text);
    later(() => setMessage(null), 2600);
  };

  const onBox = (id: string) => {
    setMessage(null);

    // 1) pick the source
    if (!source) {
      setSource(id);
      if (nodeStates[id] !== 'lit') lightUp(id);
      return;
    }

    // 2) click the source again: cancel
    if (source === id) {
      setSource(null);
      if (!hasWires(id)) setNode(id, 'idle');
      return;
    }

    // 3) pick the destination: route, then grow the wire
    const from = boxById.get(source)!;
    const to = boxById.get(id)!;
    const wireId = `${source}>${id}`;

    if (wires.some((w) => w.id === wireId)) {
      setSource(null);
      flash(`${from.label} is already wired to ${to.label}`);
      return;
    }

    const route = routeWire(boxRect(from), boxRect(to), rects);
    if (!route) {
      if (!hasWires(source)) setNode(source, 'idle');
      setSource(null);
      flash(`No free path from ${from.label} to ${to.label}`);
      return;
    }

    const dur = clamp(route.length / WIRE_SPEED, WIRE_MIN_MS, WIRE_MAX_MS);
    const strands = STRANDS.map((s) => offsetPath(route.points, s.offset).map((p) => toWorld(p)));

    setWires((ws) => [
      ...ws,
      {
        id: wireId,
        from: source,
        to: id,
        fromSide: route.fromSide,
        toSide: route.toSide,
        strands,
        t0: performance.now(),
        dur,
        arrived: false,
      },
    ]);
    setSource(null);

    // when the wire reaches the destination, its edge lights up
    later(() => {
      setWires((ws) => ws.map((w) => (w.id === wireId ? { ...w, arrived: true } : w)));
      lightUp(id);
    }, dur);
  };

  const onBoardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (source) {
      setSource(null);
      if (!hasWires(source)) setNode(source, 'idle');
    }
  };

  const clearAll = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    setWires([]);
    setNodeStates({});
    setSource(null);
    setMessage(null);
  };

  const portsFor = (id: string) =>
    wires
      .flatMap((w) => [
        w.from === id ? SIDE_LETTER[w.fromSide] : '',
        w.to === id && w.arrived ? SIDE_LETTER[w.toSide] : '',
      ])
      .filter(Boolean)
      .join(' ');

  const growing = wires.some((w) => !w.arrived);
  const phase = growing ? 'grow' : source ? 'armed' : 'idle';
  const statusText = { idle: 'standby', armed: 'pick a destination', grow: 'wire growing' }[phase];

  const hint =
    message ??
    (source
      ? `From ${boxById.get(source)!.label}: click the destination box`
      : growing
        ? 'Routing the wire'
        : wires.length
          ? 'Click another box to start a new wire'
          : 'Click a box to choose the source');

  const stageVars = cssVars({
    '--board-w': `${BOARD_W}px`,
    '--board-h': `${BOARD_H}px`,
    '--box-w': `${BOX_W}px`,
    '--box-h': `${BOX_H}px`,
    '--snap': `${RES / 2}px`,
    '--t-charge': `${CHARGE_MS}ms`,
    '--fit': fit,
  });

  const occupied = new Set(BOXES.map((b) => `${b.col},${b.row}`));

  return (
    <main className={`${styles.stage} ${mono.variable}`} style={stageVars}>
      <header className={styles.hud}>
        <div>
          <h1 className={styles.hudTitle}>Wire routing test</h1>
          <p className={styles.hudSub}>A* on a grid, rounded corners, no crossing boxes</p>
        </div>
        <div className={styles.hudActions}>
          <button
            type="button"
            className={styles.hudBtn}
            aria-pressed={showGrid}
            onClick={() => setShowGrid((v) => !v)}
          >
            Show grid
          </button>
          <button type="button" className={styles.hudBtn} onClick={clearAll} disabled={!wires.length && !source}>
            Clear wires
          </button>
          <span className={styles.chip} data-phase={phase}>
            <i className={styles.chipDot} />
            {statusText}
          </span>
        </div>
      </header>

      <div className={styles.board} data-grid={showGrid} onClick={onBoardClick}>
        <div className={styles.canvasLayer}>
          <Canvas
            orthographic
            flat
            dpr={[1, 2]}
            camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 500 }}
            gl={{ antialias: false, powerPreference: 'high-performance' }}
            resize={{ offsetSize: true }}
          >
            <Scene wires={wires} />
          </Canvas>
        </div>
        <div className={styles.grid} />

        {/* grid overlay: wire channel centre lines + empty cells */}
        {LANES_X.map((x) => (
          <i key={`lx${x}`} className={`${styles.lane} ${styles.laneV}`} style={{ left: x }} />
        ))}
        {LANES_Y.map((y) => (
          <i key={`ly${y}`} className={`${styles.lane} ${styles.laneH}`} style={{ top: y }} />
        ))}
        {SLOTS.filter((s) => !occupied.has(`${s.col},${s.row}`)).map((s) => {
          const r = boxRect(s);
          return (
            <div
              key={`s${s.col}-${s.row}`}
              className={styles.slot}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            >
              <span className={styles.slotLabel}>
                col {s.col}, row {s.row}
              </span>
            </div>
          );
        })}

        <div className={styles.scan} />
        <div className={styles.vignette} />

        {BOXES.map((b) => {
          const r = boxRect(b);
          return (
            <button
              key={b.id}
              type="button"
              className={styles.node}
              data-state={nodeStates[b.id] ?? 'idle'}
              data-selected={source === b.id}
              data-ports={portsFor(b.id)}
              aria-pressed={source === b.id}
              style={cssVars({ '--x': `${r.x}px`, '--y': `${r.y}px` })}
              onClick={() => onBox(b.id)}
            >
              <span className={styles.head}>
                <span>{b.tag}</span>
                <span className={styles.led} />
              </span>
              <span className={styles.label}>{b.label}</span>
              <span className={styles.sub}>{b.sub}</span>
              <span className={`${styles.port} ${styles.portT}`} />
              <span className={`${styles.port} ${styles.portR}`} />
              <span className={`${styles.port} ${styles.portB}`} />
              <span className={`${styles.port} ${styles.portL}`} />
            </button>
          );
        })}
      </div>

      <p className={styles.hint}>
        {hint}
        <span className={styles.caret} />
      </p>
    </main>
  );
}
