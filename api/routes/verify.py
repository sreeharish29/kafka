import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.state import StageAState
from backend.nodes import a1, a2
# Import your compiled a3 graph. Adjust the path if it's inside backend.nodes instead
from backend.nodes.a3 import a3     # ← direct import, no ambiguity
router = APIRouter()


class VerifyRequest(BaseModel):
    sentence: str = Field(..., min_length=1, max_length=5000)


@router.post("/verify")
async def verify(request: VerifyRequest):

    sentence = request.sentence.strip()

    if not sentence:
        raise HTTPException(422, "Sentence cannot be empty")

    session_id = str(uuid.uuid4())
    started = time.perf_counter()
    current_stage = "A1"

    state = StageAState(
        session_id=session_id,
        query=sentence,
    )

    try:
        # -----------------------------------------
        # A1: Memory investigation
        # -----------------------------------------
        a1_result = await a1.run(state)

        # Pass A1 results into the shared state.
        state.memory = a1_result.get("memory", {})
        state.already_present_in_db = a1_result.get("already_present_in_db", "no")
        state.retrieved_chunks = a1_result.get("retrieved_chunks", [])

        # -----------------------------------------
        # A2: Intent classification
        # -----------------------------------------
        current_stage = "A2"

        a2_result = await a2.run(state)
        
        # Pass A2 results to state (optional but good practice for full state retention)
        state.intent = a2_result.get("intent")
        state.intent_conf = a2_result.get("intent_conf", 0.0)

        # -----------------------------------------
        # A3: Reference Resolution & Search/Fetch
        # -----------------------------------------
        current_stage = "A3"
        
        # LangGraph compiled graphs use ainvoke() instead of run()
        a3_result = await a3.ainvoke(state)

        # -----------------------------------------
        # Combined response
        # -----------------------------------------
        
        return {
            "status": "success",
            "session_id": session_id,
            "sentence": sentence,
            "stage": "A1+A2+A3",

            "a1": {
                "status": "completed",
                "already_present_in_db": state.already_present_in_db,
                "memory": state.memory,
                "entities_found": len(state.memory),
                "retrieved_chunks": state.retrieved_chunks,
            },

            "a2": {
                "status": "completed",
                "intent": state.intent,
                "confidence": state.intent_conf,
                "warnings": a2_result.get("errors", []),
            },
            
            "a3": {
                "status": "completed",
                "run_id": a3_result.get("a3_run_id"),
                "skipped_crawl": a3_result.get("a3_skipped_crawl"),
                "skip_reason": a3_result.get("a3_skip_reason"),
                "queries_run": a3_result.get("a3_queries", []),
                "modified_sentence": a3_result.get("modified_sentence"),
                # Serialize Pydantic objects for the JSON response
                "entities": [e.model_dump() if hasattr(e, "model_dump") else e for e in a3_result.get("entities", [])],
                "triples": [t.model_dump() if hasattr(t, "model_dump") else t for t in a3_result.get("triples", [])],
                "unresolved_mentions": a3_result.get("a3_unresolved", []),
                "chunk_ids": a3_result.get("chunk_ids", []),
                "errors": a3_result.get("errors", [])
            },

            "execution_time_seconds": round(
                time.perf_counter() - started, 3
            ),

            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "stage": current_stage,
                "error": str(exc),
            },
        ) from exc