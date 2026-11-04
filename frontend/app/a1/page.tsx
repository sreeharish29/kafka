"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";

import styles from "./a1.module.css";

import {
  getJob,
  lastSentence,
  startVerify,
  type A1Payload,
  type RetrievedChunk,
} from "../lib/verifyClient";

const Graph3D = dynamic(() => import("../components/Graph3D"), {
  ssr: false,
  loading: () => (
    <div className={styles.graphLoading}>
      Initializing 3D investigation...
    </div>
  ),
});

// Keep the ticking clock isolated from the graph.
function ElapsedValue({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(
    () => (Date.now() - startedAt) / 1000
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsed((Date.now() - startedAt) / 1000);
    }, 200);

    return () => window.clearInterval(id);
  }, [startedAt]);

  return <>{elapsed.toFixed(1)}s</>;
}

function formatTimestamp(value?: number | string | null) {
  if (value == null) return "Unavailable";

  const date =
    typeof value === "number"
      ? new Date(value * 1000)
      : new Date(value);

  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : date.toLocaleString();
}

function formatMetadata(value: unknown) {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function A1Page() {
  const router = useRouter();

  const [sentence, setSentence] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // Streaming state — each piece fills in as its event arrives.
  const [a1, setA1] = useState<A1Payload | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [executionTime, setExecutionTime] = useState<string | null>(null);
  const [error, setError] = useState<{ stage: string; message: string } | null>(
    null
  );

  useEffect(() => {
    let job = getJob();
    if (!job) {
      const s = lastSentence();
      if (!s) {
        router.replace("/home");
        return;
      }
      job = startVerify(s);
    }

    setSentence(job.sentence);
    setStartedAt(job.startedAt);

    const unsubscribe = job.subscribe((ev) => {
      switch (ev.type) {
        case "session":
          setSessionId(ev.session_id);
          break;
        case "a1":
          setSessionId(ev.session_id);
          setA1(ev.a1);
          break;
        case "error":
          setError({ stage: ev.stage, message: ev.error });
          break;
        case "done":
          setExecutionTime(
            `${Number(ev.execution_time_seconds).toFixed(2)}s`
          );
          break;
      }
    });

    return unsubscribe;
  }, [router]);

  const memory = useMemo(
    () => (a1 ? Object.entries(a1.memory) : []),
    [a1]
  );

  const retrievedChunks: RetrievedChunk[] = useMemo(
    () => a1?.retrieved_chunks ?? [],
    [a1]
  );

  const seeds = useMemo(() => memory.map(([entity]) => entity), [memory]);

  // Derived view state
  const kind: "loading" | "done" | "error" = error
    ? "error"
    : a1
    ? "done"
    : "loading";

  const statusLabel =
    kind === "loading"
      ? "INVESTIGATING"
      : kind === "error"
      ? "FAILED"
      : "COMPLETED";

  function startNewInvestigation() {
    router.push("/home");
  }

  function Intent_classifation() {
    router.push("/a2");
  }

  return (
    <main className={styles.workspace}>
      {/* Full-screen graph */}
      <div className={styles.graphLayer}>
        <Graph3D seeds={seeds} investigating={kind !== "done"} />
      </div>

      {/* Background effects */}
      <div className={styles.ambientGlow} />
      <div className={styles.vignette} />

      {/* Top navigation */}
      <header className={styles.topBar}>
        <div className={styles.topLeft}>
          <span className={styles.stageLabel}>
            A1 <span>/</span> MEMORY INVESTIGATION
          </span>
        </div>

        <div className={styles.topCenter}>
          <span
            className={`${styles.statusDot} ${
              kind === "error"
                ? styles.statusFailed
                : kind === "done"
                ? styles.statusCompleted
                : styles.statusRunning
            }`}
          />

          <span className={styles.statusText}>{statusLabel}</span>
        </div>

        <div
          style={{
            display: "flex",
            gap: "8px",
            alignItems: "center",
            justifySelf: "end",
          }}
        >
          <button
            className={styles.newInvestigation}
            onClick={startNewInvestigation}
          >
            <span>+</span>
            New investigation
          </button>
          <button
            className={styles.newInvestigation}
            onClick={Intent_classifation}
          >
            <span>+</span>
            A2 Intent Classfication
          </button>
        </div>
      </header>

      {/* Left claim panel */}
      <aside className={`${styles.panel} ${styles.claimPanel}`}>
        <div className={styles.panelHeading}>CLAIM UNDER INVESTIGATION</div>

        <p className={styles.claimText}>
          {sentence || "Loading claim..."}
        </p>

        <div className={styles.sectionDivider} />

        <div className={styles.panelHeading}>EXECUTION STATUS</div>

        <div className={styles.statusBlock}>
          <span className={styles.statLabel}>Investigation</span>

          <span className={styles.statValue}>
            {kind === "loading"
              ? "Retrieving memory..."
              : kind === "error"
              ? "Investigation failed"
              : "Investigation completed"}
          </span>
        </div>

        {kind === "loading" && (
          <div className={styles.progressTrack}>
            <div className={styles.progressBar} />
          </div>
        )}

        {kind === "error" && (
          <div className={styles.errorMessage}>{error?.message}</div>
        )}

        {a1 && (
          <div className={styles.stats}>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>Already in memory</span>

              <span className={styles.statValue}>
                {a1.already_present_in_db === "yes" ? "Yes" : "No"}
              </span>
            </div>

            <div className={styles.statItem}>
              <span className={styles.statLabel}>Entities found</span>

              <span className={styles.statValue}>
                {a1.entities_found}
              </span>
            </div>

            <div className={styles.statItem}>
              <span className={styles.statLabel}>Qdrant chunks</span>

              <span className={styles.statValue}>
                {retrievedChunks.length}
              </span>
            </div>

            <div className={styles.statItem}>
              <span className={styles.statLabel}>Execution time</span>

              <span className={styles.statValue}>
                {executionTime ?? "—"}
              </span>
            </div>

            <div className={styles.statItem}>
              <span className={styles.statLabel}>Session ID</span>

              <span className={`${styles.statValue} ${styles.sessionId}`}>
                {sessionId ?? "—"}
              </span>
            </div>
          </div>
        )}

        {kind === "loading" && (
          <div className={styles.stats}>
            <div className={styles.statItem}>
              <span className={styles.statLabel}>Elapsed time</span>

              <span className={styles.statValue}>
                {startedAt != null ? (
                  <ElapsedValue startedAt={startedAt} />
                ) : (
                  "0.0s"
                )}
              </span>
            </div>
          </div>
        )}
      </aside>

      {/* Right-side Qdrant overlay panel */}
      <aside className={`${styles.panel} ${styles.memoryPanel}`}>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeading}>RETRIEVED MEMORY</div>

          {a1 && (
            <span className={styles.memoryCount}>
              {retrievedChunks.length} CHUNKS
            </span>
          )}
        </div>

        {kind === "loading" && (
          <div className={styles.emptyState}>
            <span className={styles.loadingOrb} />

            <p>Searching stored memory</p>

            <span>Retrieving Qdrant chunks...</span>
          </div>
        )}

        {kind === "error" && (
          <div className={styles.emptyState}>
            <p className={styles.errorText}>Memory retrieval failed</p>

            <span>{error?.message}</span>
          </div>
        )}

        {a1 && retrievedChunks.length === 0 && (
          <div className={styles.emptyState}>
            <p>No retrieved chunks</p>

            <span>Qdrant returned no matching memory chunks.</span>
          </div>
        )}

        {a1 && retrievedChunks.length > 0 && (
          <div className={styles.memoryList}>
            {retrievedChunks.map((chunk, index) => (
              <article
                key={chunk.chunk_id || `chunk-${index}`}
                className={styles.memoryCard}
              >
                {/* Card heading */}
                <div className={styles.entityHeader}>
                  <span className={styles.entityIndicator} />

                  <h3 className={styles.entityName}>CHUNK {index + 1}</h3>

                  {typeof chunk.score === "number" && (
                    <span className={styles.chunkScore}>
                      {chunk.score.toFixed(3)}
                    </span>
                  )}
                </div>

                {/* Source */}
                <div className={styles.chunkMetaBlock}>
                  <span className={styles.chunkMetaLabel}>SOURCE</span>

                  <span className={styles.chunkMetaValue}>
                    {chunk.source || "Unknown"}
                  </span>
                </div>

                {/* Chunk ID */}
                <div className={styles.chunkMetaBlock}>
                  <span className={styles.chunkMetaLabel}>CHUNK ID</span>

                  <span className={styles.chunkId}>
                    {chunk.chunk_id || "Unavailable"}
                  </span>
                </div>

                {/* Timestamp */}
                <div className={styles.chunkMetaBlock}>
                  <span className={styles.chunkMetaLabel}>CREATED AT</span>

                  <span className={styles.chunkMetaValue}>
                    {formatTimestamp(chunk.created_at)}
                  </span>
                </div>

                <div className={styles.chunkDivider} />

                {/* Full original Qdrant text */}
                <div className={styles.chunkContent}>
                  <div className={styles.chunkContentHeading}>
                    RETRIEVED TEXT
                  </div>

                  <div className={styles.chunkText}>
                    {chunk.text || "No text available."}
                  </div>
                </div>

                {/* Metadata */}
                {chunk.metadata &&
                  Object.keys(chunk.metadata).length > 0 && (
                    <details className={styles.chunkDetails}>
                      <summary>Additional metadata</summary>

                      <pre className={styles.metadataText}>
                        {formatMetadata(chunk.metadata)}
                      </pre>
                    </details>
                  )}
              </article>
            ))}
          </div>
        )}
      </aside>

      {/* Bottom graph hint */}
      <div className={styles.graphHint}>
        <span className={styles.hintDot} />
        <span>3D knowledge graph</span>
        <span className={styles.hintSeparator}>·</span>
        <span>Live visualization</span>
      </div>

      {/* Bottom graph metadata */}
      <div className={styles.graphMeta}>
        <span>
          {a1 ? `${a1.entities_found} entities` : "Graph loading"}
        </span>

        <span className={styles.hintSeparator}>·</span>

        <span>{statusLabel}</span>
      </div>
    </main>
  );
}