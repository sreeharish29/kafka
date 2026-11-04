import asyncio
import json
import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.nodes import a1, a2
from backend.nodes.a3 import a3
from backend.state import StageAState, crawl_event_queue

router = APIRouter()

HEARTBEAT_S = 15  # SSE comment ping while A3 is quiet (keeps proxies from closing the stream)


class VerifyRequest(BaseModel):
    sentence: str = Field(..., min_length=1, max_length=5000)


def sse(event: str, data: dict) -> str:
    # "event:" / "data:" lines and the blank-line terminator are all required by the SSE spec.
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def dump(x):
    return x.model_dump() if hasattr(x, "model_dump") else x


@router.post("/verify/stream")
async def verify_stream(request: VerifyRequest):
    sentence = request.sentence.strip()
    if not sentence:
        raise HTTPException(422, "Sentence cannot be empty")

    async def gen():
        session_id = str(uuid.uuid4())
        started = time.perf_counter()
        current_stage = "A1"
        a3_task: asyncio.Task | None = None
        state = StageAState(session_id=session_id, query=sentence)

        # Envelope first so the client can bind session_id immediately.
        yield sse("session", {
            "session_id": session_id,
            "sentence": sentence,
            "started_at": datetime.now(timezone.utc).isoformat(),
        })

        try:
            # ---------------- A1 ----------------
            a1_result = await a1.run(state)
            state.memory = a1_result.get("memory", {})
            state.already_present_in_db = a1_result.get("already_present_in_db", "no")
            state.retrieved_chunks = a1_result.get("retrieved_chunks", [])

            yield sse("a1", {
                "session_id": session_id,
                "a1": {
                    "status": "completed",
                    "already_present_in_db": state.already_present_in_db,
                    "memory": state.memory,
                    "entities_found": len(state.memory),
                    "retrieved_chunks": state.retrieved_chunks,
                },
            })

            # ---------------- A2 ----------------
            current_stage = "A2"
            a2_result = await a2.run(state)
            state.intent = a2_result.get("intent")
            state.intent_conf = a2_result.get("intent_conf", 0.0)

            yield sse("a2", {
                "session_id": session_id,
                "a2": {
                    "status": "completed",
                    "intent": state.intent,
                    "confidence": state.intent_conf,
                    "warnings": a2_result.get("errors", []),
                },
            })

            # ---------------- A3 ----------------
            current_stage = "A3"
            q: asyncio.Queue = asyncio.Queue()
            crawl_event_queue.set(q)  # BEFORE create_task: the task copies the current context

            a3_task = asyncio.create_task(a3.ainvoke(state))
            # Sentinel. Runs after the task ends, so every event it queued is ahead of it.
            a3_task.add_done_callback(lambda _t: q.put_nowait(None))

            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=HEARTBEAT_S)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                if ev is None:
                    break
                print("QUEUE EVENT:", ev)
                yield sse("crawl_event", ev)

            a3_result = await a3_task  # re-raises if A3 failed, handled by the except below

            yield sse("a3", {
                "session_id": session_id,
                "a3": {
                    "status": "completed",
                    "run_id": a3_result.get("a3_run_id"),
                    "skipped_crawl": a3_result.get("a3_skipped_crawl"),
                    "skip_reason": a3_result.get("a3_skip_reason"),
                    "queries_run": a3_result.get("a3_queries", []),
                    "modified_sentence": a3_result.get("modified_sentence"),
                    "entities": [dump(e) for e in a3_result.get("entities", [])],
                    "triples": [dump(t) for t in a3_result.get("triples", [])],
                    "unresolved_mentions": a3_result.get("a3_unresolved", []),
                    "chunk_ids": a3_result.get("chunk_ids", []),
                    "errors": a3_result.get("errors", []),
                },
            })

            yield sse("done", {
                "session_id": session_id,
                "execution_time_seconds": round(time.perf_counter() - started, 3),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        except Exception as exc:
            # Terminal error event: the client marks the stream finished.
            yield sse("error", {
                "session_id": session_id,
                "stage": current_stage,
                "error": str(exc),
            })

        finally:
            # Client disconnected (or we errored): do not leave the crawl running.
            if a3_task is not None and not a3_task.done():
                a3_task.cancel()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disables nginx buffering
        },
    )
