import React, { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Grid, Line, Text } from "@react-three/drei";
import * as THREE from "three";

// Spread the 6 workers evenly across a wider X-axis to fill the screen
const WORKER_POSITIONS = [-10, -6, -2, 2, 6, 10];

export type CrawlNode = {
  id: string;
  url: string;
  worker: number;
  status: "queued" | "processing" | "done" | "error";
  startTime: number;
};

// ─── Animated Data Particle ─────────────────────────────────────────────
// Shoots a glowing beam down the lane to simulate active network traffic
const DataParticle = ({ x }: { x: number }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  
  useFrame((_, delta) => {
    if (meshRef.current) {
      // Move downward incredibly fast
      meshRef.current.position.y -= delta * 25; 
      // Reset to the top once it falls off the bottom of the grid
      if (meshRef.current.position.y < -15) {
        meshRef.current.position.y = 15;
      }
    }
  });

  return (
    <mesh ref={meshRef} position={[x, 15, -0.5]}>
      <boxGeometry args={[0.1, 2.0, 0.1]} />
      <meshBasicMaterial color="#ff2a6d" transparent opacity={0.8} />
    </mesh>
  );
};

// ─── Tactical Node Block ────────────────────────────────────────────────
const NodeBox = ({ node, index }: { node: CrawlNode; index: number }) => {
  const groupRef = useRef<THREE.Group>(null);
  
  // X matches the worker lane. Y drops down based on its place in the queue.
  const x = WORKER_POSITIONS[node.worker] || 0;
  // Start high up (12), target a lower position stacking upwards
  const targetY = 6 - index * 2.5; 

  useFrame((state, delta) => {
    if (groupRef.current) {
      // Smoothly animate the group falling down the lane
      groupRef.current.position.y = THREE.MathUtils.lerp(
        groupRef.current.position.y, 
        targetY, 
        delta * 3
      );
      
      // Heartbeat pulse effect while actively processing
      if (node.status === "processing") {
        const pulse = Math.sin(state.clock.elapsedTime * 10) * 0.5 + 0.5;
        // Access the first child (the mesh) to update its material
        const boxMesh = groupRef.current.children[0] as THREE.Mesh;
        if (boxMesh && boxMesh.material) {
          (boxMesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.4 + pulse;
        }
      }
    }
  });

  // Assign tactical UI colors based on the node's backend status
  const colors = useMemo(() => {
    switch (node.status) {
      case "processing": return { core: "#ff2a6d", text: "#ff2a6d" }; // Neon Pink
      case "done": return { core: "#05d9e8", text: "#05d9e8" };       // Neon Cyan
      case "error": return { core: "#ff0000", text: "#ff4444" };      // Crimson
      default: return { core: "#444444", text: "#888888" };           // Inactive
    }
  }, [node.status]);

  // Clean the URL for a cleaner UI display
  const displayUrl = node.url.replace(/^https?:\/\/(www\.)?/, '').substring(0, 30) + "...";

  return (
    <group ref={groupRef} position={[x, 12, 0]}>
      {/* 1. The glowing data block */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[2.8, 0.4, 0.2]} />
        <meshStandardMaterial 
          color="#111" 
          emissive={colors.core}
          emissiveIntensity={node.status === "done" ? 0.3 : 0.8}
          transparent
          opacity={0.9}
        />
      </mesh>
      
      {/* 2. Native WebGL Text (Replaces the fragile HTML component) */}
      <Text
        position={[0, -0.6, 0]}
        fontSize={0.25}
        color={colors.text}
        anchorX="center"
        anchorY="top"
        maxWidth={3.8}
        font="https://fonts.gstatic.com/s/robotomono/v22/L0xuDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPOt_NqA.woff"
      >
        {`[${node.status.toUpperCase()}]\n${displayUrl}`}
      </Text>
    </group>
  );
};

// ─── Main Pipeline Engine ───────────────────────────────────────────────
export default function Pipeline3D({ activeNodes }: { activeNodes: CrawlNode[] }) {
  // Find which workers are currently active so we can fire data particles down their lanes
  const activeWorkerIds = useMemo(() => {
    return activeNodes
      .filter((n) => n.status === "processing")
      .map((n) => n.worker);
  }, [activeNodes]);

  return (
    <div className="w-full h-[70vh] min-h-[500px] bg-[#09090b] rounded-xl overflow-hidden border border-gray-800 shadow-2xl relative">
      
      <Canvas camera={{ position: [0, 0, 18], fov: 45 }}>
        <ambientLight intensity={0.8} />
        <pointLight position={[0, 10, 10]} intensity={1.5} />
        
        {/* Cyberpunk Grid Background */}
        <Grid 
          position={[0, -2, -3]} 
          args={[40, 40]} 
          cellSize={1} 
          cellThickness={1} 
          cellColor="#1a1a24" 
          sectionSize={5} 
          sectionThickness={1.2} 
          sectionColor="#2a2a35" 
          fadeDistance={40} 
        />

        {/* The 6 Worker Lanes */}
        {WORKER_POSITIONS.map((x, i) => (
          <group key={`lane-${i}`}>
            {/* Vertical fiber-optic line */}
            <Line points={[[x, 15, -1], [x, -15, -1]]} color="#222" lineWidth={2} />
            
            {/* Native WebGL Lane Headers */}
            <Text
              position={[x, 8, 0]}
              fontSize={0.4}
              color="#555555"
              anchorX="center"
              anchorY="middle"
              font="https://fonts.gstatic.com/s/robotomono/v22/L0xuDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPOt_NqA.woff"
            >
              {`WORKER_0${i}`}
            </Text>

            {/* Fire particles down this lane if this worker is processing */}
            {activeWorkerIds.includes(i) && <DataParticle x={x} />}
          </group>
        ))}

        {/* Dynamically spawned data nodes */}
        {activeNodes.map((node, i) => (
          <NodeBox key={`${node.id}-${node.status}`} node={node} index={i} />
        ))}
      </Canvas>
      
      {/* Scanline overlay for aesthetic */}
      <div className="absolute inset-0 pointer-events-none bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiPjxyZWN0IHdpZHRoPSI0IiBoZWlnaHQ9IjEiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4wMikiLz48L3N2Zz4=')] opacity-50 mix-blend-overlay"></div>
    </div>
  );
}