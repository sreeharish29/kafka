// lib/verifyClient.ts

// ─── Types ──────────────────────────────────────────────────────────

export type RetrievedChunk = {
  chunk_id: string;
  text: string;
  source: string;
  created_at?: number | string | null;
  metadata?: Record<string, unknown>;
  score?: number | null;
};

export type A1Payload = {
  status: string;
  already_present_in_db: "yes" | "no";
  memory: Record<string, { facts: string[]; sources: string[] }>;
  entities_found: number;
  retrieved_chunks: RetrievedChunk[];
};

export type A2Payload = {
  status: string;
  intent?: "challenging" | "neutral" | "evaluative";
  confidence?: number;
  warnings?: string[];
};

export type A3Payload = {
  status: string;
  run_id?: string;
  skipped_crawl?: boolean;
  skip_reason?: string;
  modified_sentence?: string;
  entities?: unknown[];
  triples?: unknown[];
  unresolved_mentions?: unknown[];
  chunk_ids?: string[];
  errors?: string[];
};

// Kept so a1/a2 imports of `VerifyResponse` keep working.
export type VerifyResponse = {
  status: string;
  session_id: string;
  sentence: string;
  stage: string;
  a1: A1Payload;
  a2?: A2Payload;
  a3?: A3Payload;
  execution_time_seconds: number;
  timestamp: string;
};

export type StageEvent =
  | { type: "session"; session_id: string; sentence: string; started_at: number }
  | { type: "a1"; session_id: string; a1: A1Payload }
  | { type: "a2"; session_id: string; a2: A2Payload }
  | { type: "a3"; session_id: string; a3: A3Payload }
  | { type: "done"; session_id: string; execution_time_seconds: number; timestamp: string }
  | { type: "error"; session_id: string; stage: string; error: string };

type Listener = (event: StageEvent) => void;

export type StreamJob = {
  sentence: string;
  startedAt: number;
  /** Replays every event emitted so far before returning. */
  subscribe: (listener: Listener) => () => void;
  snapshot: () => StageEvent[];
  abort: () => void;
  /** Legacy: resolves with the assembled response once "done" fires, rejects on "error". */
  promise: Promise<VerifyResponse>;
};

// ─── Internals ──────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const SESSION_KEY = "veritas:sentence";

let current: StreamJob | null = null;

function parseFrame(frame: string): StageEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    // lines starting with ":" are SSE heartbeats — ignore
  }
  if (!dataLines.length) return null;
  let payload: any;
  try { payload = JSON.parse(dataLines.join("\n")); } catch { return null; }
  switch (eventName) {
    case "session": return { type: "session", ...payload };
    case "a1":      return { type: "a1",      ...payload };
    case "a2":      return { type: "a2",      ...payload };
    case "a3":      return { type: "a3",      ...payload };
    case "done":    return { type: "done",    ...payload };
    case "error":   return { type: "error",   ...payload };
    default:        return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export function startVerify(sentence: string): StreamJob {
  current?.abort(); // never leak a previous SSE connection

  const listeners = new Set<Listener>();
  const events: StageEvent[] = [];
  const controller = new AbortController();
  const startedAt = Date.now();

  let resolveDone!: (v: VerifyResponse) => void;
  let rejectDone!: (e: Error) => void;
  const donePromise = new Promise<VerifyResponse>((res, rej) => {
    resolveDone = res; rejectDone = rej;
  });
  donePromise.catch(() => {}); // avoid unhandled rejection when nobody awaits

  let assembled: VerifyResponse | null = null;

  function emit(ev: StageEvent) {
    events.push(ev);

    // Accumulate into the final response so legacy `await job.promise` still works.
    if (ev.type === "session") {
      assembled = {
        status: "success",
        session_id: ev.session_id,
        sentence: ev.sentence,
        stage: "A1+A2+A3",
        a1: undefined as unknown as A1Payload, // filled by the a1 event
        execution_time_seconds: 0,
        timestamp: "",
      };
    } else if (ev.type === "a1" && assembled) {
      assembled.a1 = ev.a1;
    } else if (ev.type === "a2" && assembled) {
      assembled.a2 = ev.a2;
    } else if (ev.type === "a3" && assembled) {
      assembled.a3 = ev.a3;
    } else if (ev.type === "done") {
      if (assembled) {
        assembled.execution_time_seconds = ev.execution_time_seconds;
        assembled.timestamp = ev.timestamp;
        resolveDone(assembled);
      }
    } else if (ev.type === "error") {
      rejectDone(new Error(`[${ev.stage}] ${ev.error}`));
    }

    for (const l of listeners) l(ev);
  }

  async function run() {
    try {
      const res = await fetch(`${API_URL}/api/verify/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ sentence }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        emit({
          type: "error", session_id: "",
          stage: "request", error: text || `HTTP ${res.status}`,
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        const sep = /\r?\n\r?\n/;
        let m: RegExpExecArray | null;
        while ((m = sep.exec(buffer)) !== null) {
          const frame = buffer.slice(0, m.index);
          buffer = buffer.slice(m.index + m[0].length);
          const ev = parseFrame(frame);
          if (ev) emit(ev);
        }
      }
    } catch (err) {
      if ((err as any)?.name === "AbortError") return;
      emit({
        type: "error", session_id: "",
        stage: "network",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const job: StreamJob = {
    sentence,
    startedAt,
    subscribe(listener) {
      listeners.add(listener);
      // Replay — critical so /a2 catches up if 'a2' already fired before mount.
      for (const ev of events) listener(ev);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => [...events],
    abort: () => controller.abort(),
    promise: donePromise,
  };

  sessionStorage.setItem(SESSION_KEY, sentence);
  current = job;
  run();
  return job;
}

export function getJob(): StreamJob | null {
  return current;
}

export function lastSentence(): string | null {
  return sessionStorage.getItem(SESSION_KEY);
}