'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { CubicBezierLine, Line } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import { JetBrains_Mono } from 'next/font/google';
import styles from './a3.module.css';

const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

/* =====================================================================
   Single source of truth: layout + timing.
   These are pushed into CSS as inline variables (see stageVars below),
   and the R3F scene uses the same numbers. World units == CSS pixels
   because the canvas uses an orthographic camera at zoom 1.
   ===================================================================== */
const BOARD_W = 1160;
const BOARD_H = 560;
const BOX_W = 280;
const BOX_H = 170;
const BOX_CX = 330; // distance of each box centre from the board centre

const CHARGE_MS = 750; // left box edge lights up
const FLOW_MS = 1500; // light travels along the curves
const ARRIVE_MS = 750; // right box edge lights up

// curve endpoints sit exactly on the box edges (the .port dots)
const X_OUT = -BOX_CX + BOX_W / 2;
const X_IN = BOX_CX - BOX_W / 2;

const TRAIL_SEGMENTS = 96;
const GREEN = new THREE.Color('#2dff8f');

type Phase = 'idle' | 'charge' | 'flow' | 'arrive' | 'done';
type NodeState = 'idle' | 'charging' | 'lit';

const leftState = (p: Phase): NodeState =>
  p === 'idle' ? 'idle' : p === 'charge' ? 'charging' : 'lit';

const rightState = (p: Phase): NodeState =>
  p === 'arrive' ? 'charging' : p === 'done' ? 'lit' : 'idle';

const STATUS: Record<Phase, string> = {
  idle: 'standby',
  charge: 'charging source',
  flow: 'signal in transit',
  arrive: 'target receiving',
  done: 'path energised',
};

const HINT: Record<Phase, string> = {
  idle: 'Click the left box to send a signal',
  charge: 'Charging',
  flow: 'Sending',
  arrive: 'Receiving',
  done: 'Click the left box again to reset',
};

/* ---------------------------------------------------------------------
   Strands: three curves fanning from the left box to the right box.
   a / b are the two Bezier control-point offsets (relative to start / end).
   --------------------------------------------------------------------- */
type StrandCfg = {
  id: string;
  sy: number; // start y
  ey: number; // end y
  a: [number, number];
  b: [number, number];
  width: number; // core line width (px)
  particles: number;
  size: number; // particle size (px)
  bright: number; // 0..1 overall intensity
  seed: number;
};

const STRANDS: StrandCfg[] = [
  { id: 'main', sy: 0, ey: 0, a: [130, 80], b: [-130, -80], width: 3, particles: 90, size: 14, bright: 1, seed: 11 },
  { id: 'high', sy: 26, ey: -22, a: [160, -100], b: [-100, 110], width: 2, particles: 50, size: 10, bright: 0.7, seed: 23 },
  { id: 'low', sy: -26, ey: 22, a: [90, 40], b: [-170, -60], width: 2, particles: 50, size: 10, bright: 0.7, seed: 37 },
];

/* =====================================================================
   R3F scene
   ===================================================================== */

type Sim = { head: number; glow: number };

type LineHandle = {
  visible: boolean;
  geometry: { instanceCount: number };
  material: { opacity: number };
};

const easeInOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// scratch objects (avoid per-frame allocation)
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Advances the shared simulation (head position + glow envelope). */
function Controller({ phaseRef, sim }: { phaseRef: MutableRefObject<Phase>; sim: Sim }) {
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const p = phaseRef.current;
    const live = p === 'flow' || p === 'arrive' || p === 'done';

    sim.glow += ((live ? 1 : 0) - sim.glow) * Math.min(1, dt * 7);

    if (p === 'flow') sim.head = Math.min(1, sim.head + (dt * 1000) / FLOW_MS);
    else if (p === 'arrive' || p === 'done') sim.head = 1;
    else if (sim.glow < 0.02) sim.head = 0; // reset only once faded out
  });
  return null;
}

function Strand({
  cfg,
  sim,
  glowTex,
  dpr,
}: {
  cfg: StrandCfg;
  sim: Sim;
  glowTex: THREE.Texture;
  dpr: number;
}) {
  const curve = useMemo(
    () =>
      new THREE.CubicBezierCurve3(
        new THREE.Vector3(X_OUT, cfg.sy, 0),
        new THREE.Vector3(X_OUT + cfg.a[0], cfg.sy + cfg.a[1], 0),
        new THREE.Vector3(X_IN + cfg.b[0], cfg.ey + cfg.b[1], 0),
        new THREE.Vector3(X_IN, cfg.ey, 0),
      ),
    [cfg],
  );

  const trailPts = useMemo(() => curve.getPoints(TRAIL_SEGMENTS), [curve]);

  // bright colours (> 1) so Bloom picks them up
  const haloColor = useMemo(() => GREEN.clone().multiplyScalar(1.6), []);
  const coreColor = useMemo(() => GREEN.clone().lerp(new THREE.Color('#ffffff'), 0.35).multiplyScalar(2.4), []);
  const headColor = useMemo(() => GREEN.clone().lerp(new THREE.Color('#ffffff'), 0.5).multiplyScalar(3), []);

  const halo = useRef<LineHandle>(null);
  const core = useRef<LineHandle>(null);
  const headPts = useRef<THREE.Points>(null);
  const streamPts = useRef<THREE.Points>(null);

  // particle stream data
  const stream = useMemo(() => {
    const rnd = mulberry32(cfg.seed);
    const n = cfg.particles;
    const geo = new THREE.BufferGeometry();
    const position = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    return {
      n,
      geo,
      position,
      color,
      u: Float32Array.from({ length: n }, () => rnd()),
      speed: Float32Array.from({ length: n }, () => 0.7 + rnd() * 0.8),
      amp: Float32Array.from({ length: n }, () => (rnd() - 0.5) * 16),
      phase: Float32Array.from({ length: n }, () => rnd() * Math.PI * 2),
    };
  }, [cfg]);

  const headGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    return g;
  }, []);

  useEffect(
    () => () => {
      stream.geo.dispose();
      headGeo.dispose();
    },
    [stream, headGeo],
  );

  useFrame(({ clock }) => {
    const { head, glow } = sim;
    const e = easeInOutSine(head);
    const t = clock.elapsedTime;
    const on = glow > 0.01;

    // 1) energised trail: reveal the first N segments of the line
    const segs = Math.floor(e * TRAIL_SEGMENTS);
    const h = halo.current;
    if (h) {
      h.visible = on && segs > 0;
      h.geometry.instanceCount = segs;
      h.material.opacity = 0.2 * glow * cfg.bright;
    }
    const c = core.current;
    if (c) {
      c.visible = on && segs > 0;
      c.geometry.instanceCount = segs;
      c.material.opacity = 0.95 * glow * cfg.bright;
    }

    // 2) particle stream inside the energised part of the curve
    const sp = streamPts.current;
    if (sp) {
      sp.visible = on;
      if (on) {
        const { n, position, color, u, speed, amp, phase } = stream;
        for (let i = 0; i < n; i++) {
          const s = (u[i] + t * speed[i] * 0.32) % 1; // 0..1 travelling
          const p = s * e;
          curve.getPoint(p, _p);
          curve.getTangent(p, _t);
          const wob = Math.sin(t * 3 + phase[i]) * amp[i];
          const k = i * 3;
          position[k] = _p.x - _t.y * wob;
          position[k + 1] = _p.y + _t.x * wob;
          position[k + 2] = 0;

          const fade = Math.pow(Math.sin(Math.PI * s), 0.8) * glow * cfg.bright * (e > 0.002 ? 1 : 0);
          color[k] = 0.25 * 1.8 * fade;
          color[k + 1] = 1.0 * 1.8 * fade;
          color[k + 2] = 0.55 * 1.8 * fade;
        }
        stream.geo.attributes.position.needsUpdate = true;
        stream.geo.attributes.color.needsUpdate = true;
      }
    }

    // 3) bright head, fades out as it reaches the target box
    const hp = headPts.current;
    if (hp) {
      const mat = hp.material as THREE.PointsMaterial;
      const headOpacity = glow * (1 - smoothstep(0.9, 1, e)) * (head > 0 ? 1 : 0);
      hp.visible = headOpacity > 0.01;
      mat.opacity = headOpacity * cfg.bright;
      curve.getPoint(e, _p);
      const pos = headGeo.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, _p.x, _p.y, 0);
      pos.needsUpdate = true;
    }
  });

  return (
    <group>
      {/* dim always-on wire so the connection is visible while idle */}
      <CubicBezierLine
        start={curve.v0}
        midA={curve.v1}
        midB={curve.v2}
        end={curve.v3}
        {...({ segments: 64 } as object)} // drei types clash: Line.segments is boolean, Bezier.segments is number
        color="#2a4a3a"
        lineWidth={1}
        transparent
        opacity={0.55}
      />

      {/* energised trail: wide soft halo + thin hot core */}
      <Line
        ref={halo as never}
        points={trailPts}
        color={haloColor}
        lineWidth={cfg.width * 3.2}
        transparent
        opacity={0}
        toneMapped={false}
        depthWrite={false}
      />
      <Line
        ref={core as never}
        points={trailPts}
        color={coreColor}
        lineWidth={cfg.width}
        transparent
        opacity={0}
        toneMapped={false}
        depthWrite={false}
      />

      {/* flowing particles */}
      <points ref={streamPts} geometry={stream.geo} frustumCulled={false}>
        <pointsMaterial
          map={glowTex}
          size={cfg.size * dpr}
          sizeAttenuation={false}
          vertexColors
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>

      {/* leading spark */}
      <points ref={headPts} geometry={headGeo} frustumCulled={false}>
        <pointsMaterial
          map={glowTex}
          size={cfg.size * 3.2 * dpr}
          sizeAttenuation={false}
          color={headColor}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>
    </group>
  );
}

function Scene({ phaseRef }: { phaseRef: MutableRefObject<Phase> }) {
  const dpr = useThree((s) => s.viewport.dpr);
  const sim = useMemo<Sim>(() => ({ head: 0, glow: 0 }), []);
  const glowTex = useMemo(() => makeGlowTexture(), []);
  useEffect(() => () => glowTex.dispose(), [glowTex]);

  return (
    <>
      <color attach="background" args={['#04060a']} />
      <Controller phaseRef={phaseRef} sim={sim} />
      {STRANDS.map((cfg) => (
        <Strand key={cfg.id} cfg={cfg} sim={sim} glowTex={glowTex} dpr={dpr} />
      ))}
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

const cssVars = (v: Record<string, string | number>) => v as CSSProperties;

export default function Page() {
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const timers = useRef<number[]>([]);
  const fit = useFit();

  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const clearTimers = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };

  useEffect(() => clearTimers, []);

  const onFire = () => {
    if (phase === 'idle') {
      go('charge');
      timers.current.push(
        window.setTimeout(() => go('flow'), CHARGE_MS),
        window.setTimeout(() => go('arrive'), CHARGE_MS + FLOW_MS),
        window.setTimeout(() => go('done'), CHARGE_MS + FLOW_MS + ARRIVE_MS),
      );
    } else if (phase === 'done') {
      clearTimers();
      go('idle');
    }
  };

  const interactive = phase === 'idle' || phase === 'done';

  const stageVars = cssVars({
    '--board-w': `${BOARD_W}px`,
    '--board-h': `${BOARD_H}px`,
    '--box-w': `${BOX_W}px`,
    '--box-h': `${BOX_H}px`,
    '--t-charge': `${CHARGE_MS}ms`,
    '--t-arrive': `${ARRIVE_MS}ms`,
    '--fit': fit,
  });

  return (
    <main className={`${styles.stage} ${mono.variable}`} style={stageVars}>
      <header className={styles.hud}>
        <div>
          <h1 className={styles.hudTitle}>Signal flow test</h1>
          <p className={styles.hudSub}>two nodes, one path</p>
        </div>
        <span className={styles.chip} data-phase={phase}>
          <i className={styles.chipDot} />
          {STATUS[phase]}
        </span>
      </header>

      <div className={styles.board}>
        <div className={styles.canvasLayer}>
          <Canvas
            orthographic
            flat
            dpr={[1, 2]}
            camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 500 }}
            gl={{ antialias: false, powerPreference: 'high-performance' }}
            resize={{ offsetSize: true }}
          >
            <Scene phaseRef={phaseRef} />
          </Canvas>
        </div>
        <div className={styles.grid} />
        <div className={styles.scan} />
        <div className={styles.vignette} />

        {/* left box: the trigger */}
        <button
          type="button"
          className={styles.node}
          data-state={leftState(phase)}
          data-interactive={interactive}
          style={cssVars({ '--cx': `${-BOX_CX}px` })}
          onClick={onFire}
          aria-label="Send signal from the email triage box"
        >
          <span className={styles.head}>
            <span>source</span>
            <span className={styles.led} />
          </span>
          <span className={styles.label}>Email triage</span>
          <span className={styles.sub}>612 messages in queue, median latency 256 ms</span>
          <span className={styles.meter}>
            <span className={styles.meterFill} />
          </span>
          <span className={styles.status}>
            <span className={styles.sIdle}>ready</span>
            <span className={styles.sBusy}>charging</span>
            <span className={styles.sOn}>emitting</span>
          </span>
          <span className={`${styles.port} ${styles.portOut}`} />
        </button>

        {/* right box: the receiver */}
        <div
          className={styles.node}
          data-state={rightState(phase)}
          data-interactive="false"
          style={cssVars({ '--cx': `${BOX_CX}px` })}
        >
          <span className={styles.head}>
            <span>target</span>
            <span className={styles.led} />
          </span>
          <span className={styles.label}>Quarantine</span>
          <span className={styles.sub}>phishing score 0.97, folder set to quarantine</span>
          <span className={styles.meter}>
            <span className={styles.meterFill} />
          </span>
          <span className={styles.status}>
            <span className={styles.sIdle}>waiting for signal</span>
            <span className={styles.sBusy}>receiving</span>
            <span className={styles.sOn}>signal locked</span>
          </span>
          <span className={`${styles.port} ${styles.portIn}`} />
        </div>
      </div>

      <p className={styles.hint}>
        {HINT[phase]}
        <span className={styles.caret} />
      </p>
    </main>
  );
}