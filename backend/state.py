# backend/state.py
from __future__ import annotations

from operator import add
from typing import Annotated, Literal

from pydantic import BaseModel, Field
import contextvars

# Add this somewhere near the top of state.py
crawl_event_queue = contextvars.ContextVar("crawl_event_queue", default=None)

class Entity(BaseModel):
    mention: str                      # "India's richest man"
    resolved: str | None = None       # canonical name (filled by A3 from chunks), None if unresolved
    latent: bool = False              # unnamed placeholder (ENT1)


class Triple(BaseModel):
    subj: str                         # entity mention or placeholder
    rel: str
    obj: str


class Claim(BaseModel):
    id: str                           # "C1"
    text: str                         # standalone sentence
    triple: Triple
    kind: Literal["factual", "numeric", "subjective", "causal"] | None = None  # A6
    route: Literal["verification", "stance"] | None = None                     # A8
    depends_on: list[str] = Field(default_factory=list)  # causal: ["C3"] -> ["C1", "C2"]


class StageAState(BaseModel):
    # ---- input and meta
    session_id: str
    query: str                                        # never overwritten
    created_at: str | None = None
    errors: Annotated[list[str], add] = Field(default_factory=list)  # reducer: nodes append, nothing is lost

    # ---- A1
    memory: dict = Field(default_factory=dict)        # entity map (JSON/YAML), not prose
    already_present_in_db: Literal["yes", "no"] = "no"
    retrieved_chunks: list[dict] = Field(default_factory=list)

    # ---- A2 (not used by A3)
    intent: Literal["challenging", "neutral", "evaluative"] | None = None
    intent_conf: float = 0.0

    # ---- A3: reference resolution
    given_sentence: str | None = None                 # input sentence (defaults to query)
    modified_sentence: str | None = None              # resolved mentions replaced, rest of the sentence untouched
    chunk_ids: list[str] = Field(default_factory=list)  # Qdrant chunks that grounded the resolutions
    clarification: str | None = None                  # left empty by A3, A4 reads/fills it
    entities: list[Entity] = Field(default_factory=list)   # (+A7: same graph)
    triples: list[Triple] = Field(default_factory=list)
    a3_unresolved: list[str] = Field(default_factory=list)  # mentions A3 could not ground, A4 asks about these
    # A3 bookkeeping (temporary data, deletable by run id)
    a3_run_id: str | None = None
    a3_queries: list[str] = Field(default_factory=list)
    a3_skipped_crawl: bool = False
    a3_skip_reason: str | None = None                 # "already_in_db" | "query_failed" | "no_queries" | None
    a3_ingested_articles: int = 0
    a3_articles: dict = Field(default_factory=dict)   # transient: crawl -> ingest, cleared after ingest

    # ---- A4
    needs_clarification: bool = False
    clarification_q: str | None = None
    clarification_a: str | None = None

    # ---- A5
    neutral_text: str | None = None
    removed_spans: list[str] = Field(default_factory=list)  # goes to the stance module

    # ---- A7 / A6 / A8
    claims: list[Claim] = Field(default_factory=list)