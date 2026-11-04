"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ForceGraph3D from "react-force-graph-3d";
import SpriteText from "three-spritetext";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

const GRAPH_URL =
  process.env.NEXT_PUBLIC_GRAPH_URL || "http://localhost:8080";

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

type GraphNode = {
  key: string;
  name: string;
  display_label: string;
  color: string;
  size: number;
  type: string;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  predicate: string;
  label: string;
  color: string;
};

type GraphResponse = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type GraphData = {
  nodes: GraphNode[];
  links: GraphEdge[];
};

type Props = {
  seeds?: string[];
  /** true while the claim is still being investigated (or if it failed) */
  investigating: boolean;
};

type ViewMode = "global" | "focused";

// ---------------------------------------------------------------
// Config: tune these
// ---------------------------------------------------------------

const GLOBAL_VIEW_SECONDS = 7;

// Camera fly-in. Distances are multiples of the graph's radius.
// start = how far away the camera begins, end = where it settles.
// end < 1 means the camera finishes inside the cloud of nodes.
const FLY = {
  global: { durationMs: GLOBAL_VIEW_SECONDS * 1000, start: 4.5, end: 0.85, sweep: 1.6 },
  focused: { durationMs: 3200, start: 3.0, end: 1.5, sweep: 1.0 },
};

// Rotation after the fly-in (same sign convention as before)
const AUTO_ROTATE_SPEED = -0.35;

// Glow
const BLOOM_STRENGTH = 0.75;
const BLOOM_RADIUS = 0.7;
const BLOOM_THRESHOLD = 0.12;
const NODE_BRIGHTNESS = 1.3; // >1 pushes colours into the bloom

// Only the biggest N nodes get text labels in the global view
const GLOBAL_LABEL_COUNT = 120;

const NODE_REL_SIZE = 3;
const DEFAULT_COLOR = "#4F9DFF";
const BACKGROUND = "#090c13";

// The API sends #4F9DFF for most nodes, so colour by type here.
// Types not listed fall back to the colour from the API.
const TYPE_COLORS: Record<string, string> = {
  Person: "#FF99C8",
  Organization: "#FFC857",
  Course: "#FFC857",

  Project: "#8AC926",
  RiceProject: "#8AC926",
  Module: "#70C1B3",
  Component: "#70C1B3",
  Library: "#FF7A59",
  Technology: "#FF7A59",
  File: "#B388EB",

  Service: "#2EC4B6",
  Container: "#2EC4B6",
  KafkaTopic: "#F25F5C",
  Stage: "#F25F5C",
  Step: "#F25F5C",
  ConcurrencyModel: "#F25F5C",

  Concept: "#4F9DFF",
  Entity: "#4F9DFF",
  Domain: "#4F9DFF",
  Decision: "#FFC857",
  Rules: "#FFC857",
  Convention: "#FFC857",
  Limit: "#FFC857",

  City: "#C8D0D8",
  Country: "#C8D0D8",

  Note: "#B388EB",
  Tag: "#C8D0D8",
  Metadata: "#C8D0D8",
  Property: "#C8D0D8",
  StateField: "#C8D0D8",
  TestResult: "#8AC926",
};

// ---------------------------------------------------------------
// Stable helpers (module scope, never recreated)
// ---------------------------------------------------------------

function colorOf(node: any): string {
  return TYPE_COLORS[node.type] ?? node.color ?? DEFAULT_COLOR;
}

const nodeLabel = (n: any) => `${n.display_label || n.name} · ${n.type}`;
const nodeVal = (n: any) => Math.max(1, (n.size || 1) * 2);
const linkColor = (l: any) => l.color || "#657080";
const linkLabel = (l: any) => l.label || l.predicate || "";

// One shared geometry per detail level and one shared material per colour.
// Unlit (Basic) materials keep full brightness so the bloom pass picks them up.
const SPHERE_LOW = new THREE.SphereGeometry(1, 10, 8);
const SPHERE_HIGH = new THREE.SphereGeometry(1, 20, 16);
const materialCache = new Map<string, THREE.MeshBasicMaterial>();

function glowMaterial(hex: string): THREE.MeshBasicMaterial {
  let material = materialCache.get(hex);

  if (!material) {
    const color = new THREE.Color(hex).multiplyScalar(NODE_BRIGHTNESS);
    material = new THREE.MeshBasicMaterial({ color });
    materialCache.set(hex, material);
  }

  return material;
}

async function fetchGraph(
  params: Record<string, string>,
  signal: AbortSignal
): Promise<GraphResponse> {
  const query = new URLSearchParams(params).toString();

  const response = await fetch(`${GRAPH_URL}/api/graph?${query}`, {
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Graph API returned ${response.status}`);
  }

  return response.json();
}

type Measure = { cx: number; cy: number; cz: number; r: number };

function measureGraph(graph: any): Measure | null {
  const b = graph?.getGraphBbox?.();
  if (!b) return null;

  const [x0, x1] = b.x;
  const [y0, y1] = b.y;
  const [z0, z1] = b.z;

  if (![x0, x1, y0, y1, z0, z1].every(Number.isFinite)) return null;

  return {
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    cz: (z0 + z1) / 2,
    r: Math.max(x1 - x0, y1 - y0, z1 - z0, 60) / 2,
  };
}

// ---------------------------------------------------------------
// Component
// ---------------------------------------------------------------

function Graph3D({ seeds, investigating }: Props) {
  const graphRef = useRef<any>(null);

  const [graphData, setGraphData] = useState<GraphData>({
    nodes: [],
    links: [],
  });
  const [viewMode, setViewMode] = useState<ViewMode>("global");
  const [globalLoaded, setGlobalLoaded] = useState(false);
  const [globalReady, setGlobalReady] = useState(false);
  const [error, setError] = useState("");

  const focusedRequested = useRef(false);
  const bloomAdded = useRef(false);

  const seedString = seeds && seeds.length > 0 ? seeds.join(",") : "A1";
  const hasNodes = graphData.nodes.length > 0;
  const isFocused = viewMode === "focused";

  const viewModeRef = useRef<ViewMode>(viewMode);
  viewModeRef.current = viewMode;

  const labelKeys = useMemo(() => {
    if (viewMode === "focused") return null; // label everything
    return new Set(
      [...graphData.nodes]
        .sort((a, b) => (b.size || 1) - (a.size || 1))
        .slice(0, GLOBAL_LABEL_COUNT)
        .map((n) => n.key)
    );
  }, [graphData, viewMode]);

  const labelKeysRef = useRef<Set<string> | null>(labelKeys);
  labelKeysRef.current = labelKeys;

  // -------------------------------------------------------------
  // STAGE 1: load the complete graph
  // -------------------------------------------------------------

  useEffect(() => {
    const controller = new AbortController();

    async function loadGlobalGraph() {
      try {
        setError("");
        setGlobalLoaded(false);
        setGlobalReady(false);
        setViewMode("global");
        focusedRequested.current = false;

        const result = await fetchGraph({ limit: "10000" }, controller.signal);

        if (controller.signal.aborted) return;

        setGraphData({
          nodes: result.nodes || [],
          links: result.edges || [],
        });
        setGlobalLoaded(true);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(
          err instanceof Error ? err.message : "Unable to load global graph"
        );
      }
    }

    loadGlobalGraph();

    return () => controller.abort();
  }, []);

  // -------------------------------------------------------------
  // STAGE 2: global view stays for 7s, counted from when it loads
  // -------------------------------------------------------------

  useEffect(() => {
    if (!globalLoaded) return;

    const timer = window.setTimeout(
      () => setGlobalReady(true),
      GLOBAL_VIEW_SECONDS * 1000
    );

    return () => window.clearTimeout(timer);
  }, [globalLoaded]);

  // -------------------------------------------------------------
  // STAGE 3: 7s elapsed AND investigation finished -> 2-hop graph
  // -------------------------------------------------------------

  useEffect(() => {
    if (!globalLoaded || !globalReady || investigating) return;
    if (focusedRequested.current) return;

    const controller = new AbortController();

    async function loadFocusedGraph() {
      try {
        focusedRequested.current = true;

        const result = await fetchGraph(
          { seed: seedString, hops: "2", limit: "1000" },
          controller.signal
        );

        if (controller.signal.aborted) return;

        if (!result.nodes || result.nodes.length === 0) {
          throw new Error("The focused graph returned no nodes");
        }

        setGraphData({
          nodes: result.nodes,
          links: result.edges || [],
        });
        setViewMode("focused");
      } catch (err) {
        focusedRequested.current = false;

        if (controller.signal.aborted) return;
        setError(
          err instanceof Error ? err.message : "Unable to load focused graph"
        );
      }
    }

    loadFocusedGraph();

    return () => controller.abort();
  }, [globalLoaded, globalReady, investigating, seedString]);

  // -------------------------------------------------------------
  // GLOW: bloom post-processing, added once
  // -------------------------------------------------------------

  useEffect(() => {
    if (!hasNodes || bloomAdded.current) return;

    const graph = graphRef.current;
    const composer = graph?.postProcessingComposer?.();
    if (!composer) return;

    bloomAdded.current = true;

    composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        BLOOM_STRENGTH,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD
      )
    );

    // Bloom is fill-rate heavy; cap the pixel ratio on hi-dpi screens.
    graph.renderer?.().setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  }, [hasNodes]);

  // -------------------------------------------------------------
  // CAMERA: fly in from far away while orbiting, then hand over
  // to normal auto-rotate. Runs for each new dataset.
  // -------------------------------------------------------------

  useEffect(() => {
    if (!hasNodes) return;

    const cfg = FLY[viewMode];
    let raf = 0;
    let cancelled = false;
    let controls: any = null;
    let onUserStart: (() => void) | null = null;

    function handOver() {
      if (controls) controls.autoRotate = true;
    }

    function begin() {
      const graph = graphRef.current;
      controls = graph?.controls?.();

      // The graph mounts a frame after this effect; wait for it.
      if (!graph || !controls) {
        raf = requestAnimationFrame(begin);
        return;
      }

      controls.autoRotate = false;
      controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
      controls.enableDamping = true;
      controls.dampingFactor = 0.04;

      // If the user grabs the scene, stop animating and let them drive.
      onUserStart = () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        handOver();
      };
      controls.addEventListener("start", onUserStart);

      const startTheta = 0.4;
      const startPhi = 1.05; // polar angle: smaller = higher above the graph
      const endPhi = 1.25;

      let last: Measure = measureGraph(graph) ?? {
        cx: 0,
        cy: 0,
        cz: 0,
        r: 400,
      };
      let smoothR = last.r;
      const t0 = performance.now();

      function step(now: number) {
        if (cancelled) return;

        const p = Math.min(1, (now - t0) / cfg.durationMs);
        const e = 1 - Math.pow(1 - p, 3); // ease-out: fast approach, soft landing

        // The layout is still expanding, so track its size every frame.
        const m = measureGraph(graph);
        if (m) last = m;
        smoothR += (last.r - smoothR) * 0.15;

        const dist = smoothR * (cfg.start + (cfg.end - cfg.start) * e);
        const theta = startTheta + cfg.sweep * e;
        const phi = startPhi + (endPhi - startPhi) * e;
        const sinPhi = Math.sin(phi);

        graph.cameraPosition(
          {
            x: last.cx + dist * sinPhi * Math.sin(theta),
            y: last.cy + dist * Math.cos(phi),
            z: last.cz + dist * sinPhi * Math.cos(theta),
          },
          { x: last.cx, y: last.cy, z: last.cz },
          0
        );

        if (p < 1) {
          raf = requestAnimationFrame(step);
        } else {
          handOver();
        }
      }

      raf = requestAnimationFrame(step);
    }

    begin();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (controls && onUserStart) {
        controls.removeEventListener("start", onUserStart);
      }
    };
  }, [graphData, viewMode, hasNodes]);

  // -------------------------------------------------------------
  // NODES: glowing sphere, plus a label for the nodes that get one
  // (stable identity, reads refs)
  // -------------------------------------------------------------

  const createNodeObject = useCallback((node: any) => {
    const focused = viewModeRef.current === "focused";
    const radius = NODE_REL_SIZE * Math.cbrt(nodeVal(node));

    const sphere = new THREE.Mesh(
      focused ? SPHERE_HIGH : SPHERE_LOW,
      glowMaterial(colorOf(node))
    );
    sphere.scale.setScalar(radius);

    const keys = labelKeysRef.current;
    if (keys && !keys.has(node.key)) return sphere;

    const sprite = new SpriteText(node.display_label || node.name || node.key);
    sprite.color = colorOf(node);
    sprite.textHeight = 3.5;
    sprite.backgroundColor = "rgba(5, 8, 18, 0.75)";
    sprite.padding = 1.5;
    sprite.borderRadius = 2;
    sprite.position.y = radius + 5;
    sprite.material.depthWrite = false;

    const group = new THREE.Group();
    group.add(sphere);
    group.add(sprite);
    return group;
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: BACKGROUND,
        overflow: "hidden",
      }}
    >
      {hasNodes && (
        <ForceGraph3D
          ref={graphRef}
          graphData={graphData}
          nodeId="key"
          backgroundColor={BACKGROUND}
          showNavInfo={false}
          enableNavigationControls={true}
          controlType="orbit"
          enableNodeDrag={false}
          rendererConfig={{
            antialias: false,
            powerPreference: "high-performance",
          }}
          nodeThreeObject={createNodeObject}
          nodeLabel={nodeLabel}
          linkColor={linkColor}
          linkLabel={linkLabel}
          linkOpacity={0.4}
          linkWidth={isFocused ? 0.7 : 0}
          linkDirectionalParticles={isFocused ? 1 : 0}
          linkDirectionalParticleWidth={1.4}
          linkDirectionalParticleSpeed={0.002}
          warmupTicks={60}
          cooldownTime={isFocused ? 3000 : 6000}
          d3AlphaDecay={0.025}
          d3VelocityDecay={0.25}
        />
      )}

      {error && (
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: 24,
            color: "#ff8b9b",
            fontSize: 12,
            background: "rgba(20,12,24,.85)",
            padding: "10px 14px",
            borderRadius: 8,
          }}
        >
          Graph unavailable: {error}
        </div>
      )}

      <div
        style={{
          position: "absolute",
          bottom: 16,
          right: 20,
          color: "#9298a8",
          fontSize: 11,
          pointerEvents: "none",
          background: "rgba(9,12,19,.65)",
          padding: "6px 10px",
          borderRadius: 6,
        }}
      >
        {isFocused
          ? `2-HOP INVESTIGATION GRAPH · ${graphData.nodes.length} NODES`
          : `GLOBAL KNOWLEDGE GRAPH · ${graphData.nodes.length} NODES`}
      </div>
    </div>
  );
}

// Re-render only when the seed list or investigating flag really change,
// so the parent's state updates never touch the WebGL scene.
export default memo(
  Graph3D,
  (prev, next) =>
    prev.investigating === next.investigating &&
    (prev.seeds ?? []).join(",") === (next.seeds ?? []).join(",")
);