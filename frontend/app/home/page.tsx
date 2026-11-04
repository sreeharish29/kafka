"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./home.module.css";
import { startVerify } from "../lib/verifyClient";

type Phase = "idle" | "firing" | "arrived";
type Spark = { x: number; y: number; vx: number; vy: number; life: number; hue: number };

// Timeline (ms)
const PULSE_MS = 280; // button pulse before the beam leaves
const TRAVEL_MS = 900; // beam crosses the screen
const ARRIVE_MS = 450; // right edge flash before redirect

const easeInCubic = (t: number) => t * t * t;

export default function HomePage() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    router.prefetch("/a1");
    return () => cancelAnimationFrame(rafRef.current);
  }, [router]);

  const fireLaser = useCallback(() => {
    const canvas = canvasRef.current;
    const btn = buttonRef.current;
    if (!canvas || !btn) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const rect = btn.getBoundingClientRect();
    const startX = rect.right - 6;
    const y = rect.top + rect.height / 2;
    const trailLen = W * 0.5;
    const sparks: Spark[] = [];
    const t0 = performance.now();

    const frame = (now: number) => {
      const t = Math.min((now - t0) / TRAVEL_MS, 1);
      const headX = startX + (W + 40 - startX) * easeInCubic(t);
      const tailX = Math.max(startX, headX - trailLen);

      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";

      // Soft layered trail: blue haze, magenta body, pink, white core
      const layers: [string, number, number][] = [
        ["rgba(70,120,255,0.20)", 26, 40],
        ["rgba(255,40,170,0.35)", 10, 24],
        ["rgba(255,120,200,0.8)", 4, 14],
        ["rgba(255,255,255,1)", 1.6, 8],
      ];
      for (const [color, width, blur] of layers) {
        const g = ctx.createLinearGradient(tailX, 0, headX, 0);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(1, color);
        ctx.strokeStyle = g;
        ctx.lineWidth = width;
        ctx.shadowColor = color;
        ctx.shadowBlur = blur;
        ctx.beginPath();
        ctx.moveTo(tailX, y);
        ctx.lineTo(headX, y);
        ctx.stroke();
      }

      // Thin wavering filaments trailing the beam
      ctx.shadowBlur = 6;
      for (let i = 0; i < 4; i++) {
        const amp = 6 + i * 5;
        const hue = i % 2 ? "rgba(90,140,255,0.5)" : "rgba(255,70,190,0.5)";
        ctx.strokeStyle = hue;
        ctx.shadowColor = hue;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let x = tailX; x <= headX; x += 8) {
          const k = (x - tailX) / Math.max(headX - tailX, 1);
          const off = Math.sin(x * 0.02 + now * 0.01 + i * 1.7) * amp * k;
          if (x === tailX) ctx.moveTo(x, y + off);
          else ctx.lineTo(x, y + off);
        }
        ctx.stroke();
      }

      // Head flare
      const flare = ctx.createRadialGradient(headX, y, 0, headX, y, 46);
      flare.addColorStop(0, "rgba(255,255,255,0.95)");
      flare.addColorStop(0.25, "rgba(255,110,200,0.55)");
      flare.addColorStop(1, "rgba(255,40,170,0)");
      ctx.shadowBlur = 0;
      ctx.fillStyle = flare;
      ctx.fillRect(headX - 50, y - 50, 100, 100);

      // Sparks
      if (t < 1) {
        for (let i = 0; i < 3; i++) {
          sparks.push({
            x: headX,
            y,
            vx: -Math.random() * 2.5 - 0.5,
            vy: (Math.random() - 0.5) * 3.5,
            life: 1,
            hue: Math.random() > 0.5 ? 320 : 220,
          });
        }
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.x += s.vx;
        s.y += s.vy;
        s.life -= 0.035;
        if (s.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        ctx.fillStyle = `hsla(${s.hue},100%,75%,${s.life})`;
        ctx.fillRect(s.x, s.y, 2, 2);
      }

      if (t < 1 || sparks.length) rafRef.current = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    };
    rafRef.current = requestAnimationFrame(frame);
  }, []);

  const submit = useCallback(() => {
    const sentence = text.trim();
    if (!sentence || phase !== "idle") return;

    // Request starts now, in parallel with the animation; A1 picks up the same request
    startVerify(sentence);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      router.push("/a1");
      return;
    }

    setPhase("firing");
    window.setTimeout(fireLaser, PULSE_MS);
    window.setTimeout(() => setPhase("arrived"), PULSE_MS + TRAVEL_MS);
    window.setTimeout(() => router.push("/a1"), PULSE_MS + TRAVEL_MS + ARRIVE_MS);
  }, [text, phase, fireLaser, router]);

  return (
    <main className={styles.page} data-phase={phase}>
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden />
      <div className={styles.edge} aria-hidden />

      <section className={styles.center}>
        <h1 className={styles.heading}>Verify the given sentence</h1>

        <div className={styles.field}>
          <textarea
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Enter a sentence or claim to verify..."
            rows={5}
            readOnly={phase !== "idle"}
            autoFocus
            spellCheck={false}
          />
        </div>

        <div className={styles.row}>
          <span className={styles.hint}>Ctrl + Enter to submit</span>
          <button
            ref={buttonRef}
            className={styles.button}
            onClick={submit}
            disabled={!text.trim() || phase !== "idle"}
          >
            <span className={styles.spark} aria-hidden>
              ✦
            </span>
            Verify sentence
            <span className={styles.arrow} aria-hidden>
              →
            </span>
          </button>
        </div>
      </section>
    </main>
  );
}