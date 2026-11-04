"""Stage A3 - Reference Resolution (Qdrant-only): queries -> crawl -> ingest -> grounded GraphCheck-style resolve."""
from __future__ import annotations

import asyncio, inspect, json, os, re, uuid
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain_core.prompts import ChatPromptTemplate
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

try:
    from backend.state import Entity, StageAState, Triple
except ImportError:
    try:
        from ..state import Entity, StageAState, Triple
    except ImportError:
        from state import Entity, StageAState, Triple

try:
    from backend.helper.search_fetch import run_pipeline
except ImportError:
    try:
        from ..helper.search_fetch import run_pipeline
    except ImportError:
        from search_fetch import run_pipeline

load_dotenv()

CONFIG_PATH = Path(__file__).resolve().parent.parent / "prompt_templates" / "a3.json"
CFG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
C = CFG["config"]
LIM, TMP = C["limits"], C["temp_metadata"]
PROMPTS = {k: ChatPromptTemplate.from_messages([tuple(m) for m in CFG[k]])
           for k in ("queries", "slots", "fill_one", "triples")}
for _k, _p in PROMPTS.items():   # fail fast on a stray "{}" in a3.json
    if "" in _p.input_variables:
        raise RuntimeError(f"prompt '{_k}' in a3.json has a stray '{{}}', escape it as '{{{{}}}}'")

DEBUG = lambda: bool(os.getenv("A3_DEBUG"))


def dbg(*a):
    if DEBUG():
        print("[A3]", *a)


# ---------------------------------------------------------------- schemas
class QueryList(BaseModel):
    queries: list[str] = Field(default_factory=list)

class Slot(BaseModel):
    mention: str
    question: str

class SlotList(BaseModel):
    slots: list[Slot] = Field(default_factory=list)

class Fill(BaseModel):
    mention: str
    resolution: Optional[str] = None
    evidence_quote: Optional[str] = None
    chunk_ids: list[str] = Field(default_factory=list)
    follow_up_query: Optional[str] = None

class LTriple(BaseModel):
    subj: str
    rel: str
    obj: str

class TripleList(BaseModel):
    triples: list[LTriple] = Field(default_factory=list)


# ---------------------------------------------------------------- LLM
_llms: dict[float, Any] = {}


def llm(temp: float = 0.0):
    if temp not in _llms:
        _llms[temp] = init_chat_model(os.getenv(C["model"]["name_env"], C["model"]["default"]), temperature=temp)
    return _llms[temp]


async def ask(key: str, schema, **kw):
    """Structured call. A parse failure is retried with a little temperature (temp 0 repeats the same empty reply)."""
    for i in range(3):
        try:
            return await (PROMPTS[key] | llm(0.0 if i == 0 else 0.3).with_structured_output(schema)).ainvoke(kw)
        except Exception as e:
            if i == 2 or not any(s in type(e).__name__ for s in ("OutputParser", "Validation")):
                raise


def root_cause(e: BaseException) -> str:
    while isinstance(e, BaseExceptionGroup) and e.exceptions:
        e = e.exceptions[0]
    return f"{type(e).__name__}: {e}"


# ---------------------------------------------------------------- MCP (one session, owned by ONE task)
_st: dict[str, Any] = {"task": None, "q": None}
_lock = asyncio.Lock()


def as_text(res: Any) -> str:
    if isinstance(res, tuple):
        res = res[0]
    if isinstance(res, list):
        return "\n".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in res)
    return res if isinstance(res, str) else str(res)


async def _owner(q: asyncio.Queue, ready: asyncio.Future):
    """Opens and closes the MCP session in the same task (anyio requires it)."""
    try:
        client = MultiServerMCPClient({"pop_os": {
            "url": os.getenv(C["mcp"]["url_env"], C["mcp"]["default_url"]),
            "transport": C["mcp"]["transport"],
            "headers": {"ngrok-skip-browser-warning": "1"}}})
        async with client.session("pop_os") as session:
            tools = {t.name: t for t in await load_mcp_tools(session)}
            ready.set_result(None)
            while (item := await q.get()) is not None:
                name, args, fut = item
                try:
                    t = next((v for k, v in tools.items() if k == name or k.endswith(name)), None)
                    if t is None:
                        raise KeyError(f"MCP tool not found: {name}")
                    fut.set_result(as_text(await t.ainvoke(args)))
                except Exception as e:
                    fut.set_exception(e)
                    break                       # drop the session, the next call reconnects
    except Exception as e:
        if not ready.done():
            ready.set_exception(e)


async def call(name: str, **args) -> str:
    last = ""
    for attempt in range(3):
        try:
            async with _lock:
                if _st["task"] is None or _st["task"].done():
                    ready, _st["q"] = asyncio.get_running_loop().create_future(), asyncio.Queue()
                    _st["task"] = asyncio.create_task(_owner(_st["q"], ready))
                    await ready
                fut = asyncio.get_running_loop().create_future()
                await _st["q"].put((name, args, fut))
                return await fut
        except Exception as e:
            last = root_cause(e)
            t = _st["task"]
            if t and not t.done():
                await asyncio.wait({t}, timeout=5)
                t.cancel()
            await asyncio.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{name} failed after 3 tries: {last}")


async def close():
    """Call once at the very end so the session closes cleanly."""
    t = _st["task"]
    if t and not t.done():
        await _st["q"].put(None)
        await asyncio.wait({t}, timeout=5)


# ---------------------------------------------------------------- helpers & guards
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}")
STOP = {"the", "that", "this", "with", "from", "will", "have", "has", "had", "was", "were", "been", "after",
        "into", "than", "more", "said", "says", "its", "their", "which", "also", "about", "over", "for", "and"}

# Back-references ("the old one", "that scheme") may legitimately share an answer with another mention
ANAPHOR = re.compile(r"\b(old|older|previous|former|earlier|same|that|this|such|latter|it|one)\b", re.I)

# Guard 1: Slots that are general metrics/concepts rather than named entities/schemes
CONCEPT_SLOT_RE = re.compile(
    r"^(?:the\s+|a\s+|an\s+)?(?:repo\s+rate|reverse\s+repo\s+rate|interest\s+rate|inflation(?:\s+rate)?|"
    r"gdp(?:\s+growth)?|unemployment(?:\s+rate)?|tax\s+rate|gst\s+rate|rates?|prices?|tariffs?|"
    r"health\s+insurance|life\s+insurance|fiscal\s+deficit|liquidity|economy|market|markets|growth)\b$",
    re.I,
)

# Guard 2: Resolutions that are numeric values, percentages, money amounts, dates, or durations
VALUE_RE = re.compile(
    r"^[\d\s.,%$₹€£+\-–—/]+$|"
    r"(?:^|\b)\d+(?:\.\d+)?\s*(?:%|percent|per\s+cent|bps|basis\s+points?|crores?|lakhs?|millions?|billions?|"
    r"trillions?|days?|weeks?|months?|years?|hours?|kmph|kg|tons?)\b|"
    r"^(?:rs\.?|inr|usd|\$|₹)\s*\d+",
    re.I,
)

# Guard 3: Resolutions that are full clauses / predicates containing finite verbs or copulas
CLAUSE_RE = re.compile(
    r"\b(?:is|are|was|were|be|been|being|has|have|had|will|would|shall|should|can|could|may|might|must|"
    r"said|says|told|asked|ordered|granted|kept|keep|keeps|remained|remains|rose|fell|dropped|increased|"
    r"decreased|cancelled|approved|replaced|moved|went|comes|came|according|because|while|after|before)\b",
    re.I,
)

# Boilerplate cutoffs for crawled news markdown (prevents indexing unrelated footer/sidebar headlines)
FOOTER_CUTOFF_RE = re.compile(
    r"(?:^|\n)(?:#+\s*\[?(?:Latest\s+News|Related\s+News|Top\s+Stories|Trending\s+Topics|Also\s+Read|"
    r"More\s+News|Read\s+Also)\b|End\s+of\s+Article|Subscribe\s+to\s+our\s+daily\s+Newsletter|"
    r"SUBSCRIBE\s+TO\s+OUR\s+NEWSLETTER|\|\s*TRENDING\s+TOPICS\s*\||\|\s*\*\*Top\s+Stories\*\*\s*\|"
    r"|also\s+in\s+\[\s*National\s+News\s*\])",
    re.I,
)
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((?:https?://|javascript:|whatsapp://|/)[^)]*\)")
NOISE_LINE_RE = re.compile(
    r"^(?:\[?(?:0\s+SHARES|0\s+COMMENTS|Share|Tweet|COMMENT|follow\s+us|Submit|Previous|Next|VAMP)\]?|"
    r"\|\s*---+\s*\||Photo\s*:\s*\w+|Updated(?:\s+on)?\s*:.*|First\s+published\s*:.*)$",
    re.I,
)


def clean_article(raw: str) -> str:
    """Strip sidebar/footer unrelated news and markdown link URLs before chunking."""
    if not raw:
        return ""
    # 1. Cut off at the first footer / related-stories marker
    m = FOOTER_CUTOFF_RE.search(raw)
    if m and m.start() > 250:
        raw = raw[:m.start()]
    # 2. Replace [anchor](url) with plain anchor text
    text = MD_LINK_RE.sub(r"\1", raw)
    # 3. Clean table pipes and drop boilerplate social/share lines
    lines: list[str] = []
    for line in text.splitlines():
        s = line.strip().strip("|").strip()
        if not s or NOISE_LINE_RE.match(s):
            continue
        lines.append(s)
    return "\n\n".join(lines)


def parse_chunk_ids(text: str) -> list[str]:
    found: list[str] = []

    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k in ("chunk_ids", "ids") and isinstance(v, list):
                    found.extend(map(str, v))
                elif k == "chunk_id" and isinstance(v, str):
                    found.append(v)
                else:
                    walk(v)
        elif isinstance(x, list):
            for i in x:
                walk(i)

    try:
        walk(json.loads(text))
    except Exception:
        pass
    return found or list(dict.fromkeys(UUID_RE.findall(text)))


def parse_search(text: str) -> list[dict]:
    try:
        data = json.loads(text)
        data = data.get("results", data.get("chunks", [])) if isinstance(data, dict) else data
        return [d for d in data if isinstance(d, dict) and d.get("chunk_id")]
    except Exception:
        return []


def chunk_text(text: str) -> list[str]:
    """Sentence-aware splitter with overlap, so clauses like 'replaced X with Y' survive chunk borders."""
    text = clean_article(text)
    if not text or not text.strip():
        return []
    try:
        from langchain_text_splitters import RecursiveCharacterTextSplitter
        sp = RecursiveCharacterTextSplitter(chunk_size=LIM["chunk_chars"], chunk_overlap=LIM["chunk_overlap"],
                                            separators=["\n\n", "\n", ". ", "? ", "! ", " ", ""])
        return sp.split_text(text)[: LIM["max_chunks_per_article"]]
    except ImportError:
        size, parts, buf = LIM["chunk_chars"], [], ""
        for para in filter(None, (p.strip() for p in re.split(r"\n\s*\n", text))):
            if len(buf) + len(para) + 2 <= size:
                buf = f"{buf}\n\n{para}" if buf else para
                continue
            if buf:
                parts.append(buf)
            while len(para) > size:
                parts.append(para[:size]); para = para[size:]
            buf = para
        return (parts + ([buf] if buf else []))[: LIM["max_chunks_per_article"]]


run_source = lambda rid: f"{TMP['source_prefix']}{rid}"
memory_text = lambda m: json.dumps(m, ensure_ascii=False) if m else "(empty)"
dumps = lambda x: json.dumps(x, ensure_ascii=False)
norm = lambda s: re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", (s or "").lower())).strip()
stems = lambda s: {w[:5] for w in norm(s).split() if len(w) > 3 and w not in STOP}


def valid_resolution(mention: str, res: str) -> Optional[str]:
    """Return a rejection reason if `res` is a value, a verb clause, or identical to `mention`; else None."""
    r = (res or "").strip()
    if not r:
        return "empty"
    if norm(r) == norm(mention):
        return "same_as_mention"
    if len(r.split()) > 12 or any(ch in r for ch in (";", "?", "!", "\n")):
        return "too_long_or_punct"
    if VALUE_RE.search(r):
        return "value_or_number"
    if CLAUSE_RE.search(r):
        return "clause_with_verb"
    return None


def grounded_chunk(fill: Fill, chunks: dict[str, str], mention: str, sentence: str) -> Optional[str]:
    """Return the chunk id that really contains the quoted evidence AND the resolution headwords, or None.
    1) the quote must appear (>=90%) in a retrieved chunk,
    2) the resolution's key words (or acronym) must appear in the quote/chunk,
    3) the quote must be on topic: share a word with the mention, or >= min_overlap words with the sentence."""
    q = norm(fill.evidence_quote)
    r = norm(fill.resolution)
    if len(q) < 15 or not r:
        return None
    r_words = [w for w in r.split() if w not in STOP]
    if not r_words:
        return None
    cited = [c for c in fill.chunk_ids if c in chunks] or list(chunks)
    for cid in cited:
        t = norm(chunks[cid])
        m = SequenceMatcher(None, q, t, autojunk=False).find_longest_match(0, len(q), 0, len(t))
        if q in t or m.size >= 0.9 * len(q):
            # Ensure the resolution itself is actually grounded in the chunk text
            if not any(w in t for w in r_words):
                continue
            qs = stems(q)
            if (stems(mention) & qs) or len(stems(sentence) & qs) >= LIM["min_overlap"]:
                return cid
    return None


def substitute(sentence: str, resolved: dict[str, str]) -> tuple[str, set[str]]:
    """Replace ONLY the resolved mentions inside the original sentence. Every other word stays untouched."""
    spans: list[tuple[int, int, str]] = []
    applied: set[str] = set()
    for m, r in sorted(resolved.items(), key=lambda kv: -len(kv[0])):
        hit = re.search(re.escape(m), sentence, re.I)
        if not hit or any(hit.start() < e and s < hit.end() for s, e, _ in spans):
            continue
        rep = r.strip()
        # Preserve leading "the " when the mention has it and the resolution is an institution/title without it
        if m.lower().startswith("the ") and not rep.lower().startswith(("the ", "a ", "an ")):
            # If resolution is an acronym like "RBI" or "SBI", or starts with "Reserve Bank" / "Central", add "the "
            if rep.isupper() or re.match(r"^(?:Reserve|Central|Union|State|Supreme|High|Enforcement|Election)\b", rep, re.I):
                rep = f"the {rep}"
        if m[:1].isupper() and rep[:1].islower():
            rep = rep[0].upper() + rep[1:]
        spans.append((hit.start(), hit.end(), rep))
        applied.add(m)
    out, pos = [], 0
    for s, e, rep in sorted(spans):
        out += [sentence[pos:s], rep]
        pos = e
    out.append(sentence[pos:])
    return "".join(out), applied


# ---------------------------------------------------------------- nodes
async def make_queries(state: StageAState) -> dict:
    sentence = state.given_sentence or state.query
    base = {"a3_run_id": state.a3_run_id or uuid.uuid4().hex[:12], "given_sentence": sentence,
            "clarification": "", "chunk_ids": [], "entities": [], "triples": [], "a3_unresolved": []}
    # if state.already_present_in_db == "yes":
    #     return {**base, "a3_skipped_crawl": True, "a3_skip_reason": "already_in_db", "a3_queries": []}
    try:
        out = await ask("queries", QueryList, memory=memory_text(state.memory),
                        sentence=sentence, n=LIM["max_queries"])
    except Exception as e:
        return {**base, "a3_skipped_crawl": True, "a3_skip_reason": "query_failed", "a3_queries": [],
                "errors": [f"A3.make_queries: {root_cause(e)}"]}
    qs = [q.strip() for q in out.queries if q.strip()][: LIM["max_queries"]]
    return {**base, "a3_skipped_crawl": not qs, "a3_skip_reason": None if qs else "no_queries", "a3_queries": qs}


async def crawl(state: StageAState) -> dict:
    try:
        # Import the queue and the Emitter
        from backend.state import crawl_event_queue
        from backend.helper.search_fetch import Emitter, run_pipeline
        import inspect
        
        # 1. Safely grab the queue set by FastAPI
        try:
            q = crawl_event_queue.get()
        except LookupError:
            q = None
            
        # 2. Wire the emitter to push directly into the queue
        emitter = None
        if q is not None:
            emitter = Emitter(sinks=[lambda ev: q.put_nowait(ev)])
            
        # 3. CRITICAL: Pass emit=emitter into run_pipeline
        res = run_pipeline(state.a3_queries, emit=emitter)
        
        return {"a3_articles": (await res if inspect.isawaitable(res) else res) or {}}
    except Exception as e:
        from backend.nodes.a3 import root_cause # adjust import if needed
        return {"a3_articles": {}, "errors": [f"A3.crawl: {root_cause(e)}"]}


async def ingest(state: StageAState) -> dict:
    """Chunk articles and store ONLY in Qdrant, tagged temporary + run id. Input: {url: {title, text, success, ...}}"""
    rid, now = state.a3_run_id, datetime.now(timezone.utc).isoformat()
    sentence, source = state.given_sentence or state.query, run_source(state.a3_run_id)
    errors: list[str] = []
    all_ids: list[str] = []
    md = [f"# TEMP A3 run {rid}", f"- sentence: {sentence}", f"- queries: {state.a3_queries}", ""]
    ingested = 0
    for url, art in list((state.a3_articles or {}).items())[: LIM["max_articles"]]:
        if not isinstance(art, dict) or art.get("success") is False:
            continue
        chunks = chunk_text((art.get("text") or "").strip())
        if not chunks:
            continue
        title = (art.get("title") or url or "")[:200] or "untitled"
        try:
            res = await call("memory_store_document", chunks=chunks, document_title=title,
                             project_id=TMP["project_id"], source=source,
                             metadata={"temporary": True, "a3_run_id": rid, "session_id": state.session_id,
                                       "url": url, "final_url": art.get("final_url") or url, "title": title,
                                       "found_by": art.get("found_by") or [], "fetched_at": now})
            ids = parse_chunk_ids(res)
            all_ids += ids
            ingested += 1
            md += [f"## {title}", f"- url: {url}", f"- chunks: {len(ids)}", ""]
        except Exception as e:
            errors.append(f"A3.ingest[{url[:80]}]: {root_cause(e)}")
    try:
        await call("memory_store", text="\n".join(md), title=f"A3 run {rid}",
                   chat_name=f"{TMP['md_chat_name_prefix']}{rid}", save_md=True, save_vector=False, source=source)
    except Exception as e:
        errors.append(f"A3.ingest.md: {root_cause(e)}")
    return {"a3_articles": {}, "chunk_ids": all_ids, "a3_ingested_articles": ingested,
            **({"errors": errors} if errors else {})}


async def resolve(state: StageAState) -> dict:
    """GraphCheck-style rotation, one slot per call, every answer checked in code before it is accepted.
    Scope: already_in_db -> whole Qdrant collection, otherwise only THIS run's temporary source.
    Set A3_DEBUG=1 to print why each slot was resolved, rejected or left null."""
    sentence, mem = state.given_sentence or state.query, memory_text(state.memory)
    already_in_db = state.already_present_in_db == "yes" or getattr(state, "a3_skip_reason", None) == "already_in_db"
    scope = {} if already_in_db else {"source": run_source(state.a3_run_id)}
    errors: list[str] = []
    base = {"given_sentence": sentence, "modified_sentence": sentence, "chunk_ids": [],
            "clarification": "", "entities": [], "triples": [], "a3_unresolved": []}

    try:
        raw_slots = (await ask("slots", SlotList, memory=mem, sentence=sentence)).slots
    except Exception as e:
        return {**base, "errors": [f"A3.slots: {root_cause(e)}"]}

    pending: dict[str, str] = {}
    for s in raw_slots:
        m_clean = s.mention.strip()
        if not m_clean or not re.search(re.escape(m_clean), sentence, re.I):
            dbg(f"slot {m_clean!r}: DROPPED (not verbatim in sentence)")
            continue
        if CONCEPT_SLOT_RE.match(m_clean):
            dbg(f"slot {m_clean!r}: DROPPED (general concept/metric, not an entity reference)")
            continue
        pending[m_clean] = s.question

    dbg("slots:", pending)
    if not pending:
        return base

    order = list(pending)
    resolved: dict[str, str] = {}
    cites: dict[str, str] = {}                        # mention -> chunk id that grounds it
    for round_i in range(LIM["graphcheck_rounds"]):   # rotation: [1,2,3] -> [2,3,1] -> [3,1,2]
        if not pending:
            break
        k = round_i % len(order)
        for mention in [m for m in order[k:] + order[:k] if m in pending]:
            question = pending[mention]
            ctx = " ".join(f"{a}={b}" for a, b in resolved.items())
            try:
                hits = [h for h in parse_search(await call(
                    "memory_search", query=f"{mention} {question} {ctx}".strip()[:300],
                    limit=LIM["retrieve_k"], **scope)) if (h.get("score") or 1.0) >= LIM["min_score"]]
                if not hits:
                    dbg(f"round {round_i} {mention!r}: no chunk above min_score")
                    continue
                chunks = {h["chunk_id"]: h.get("text") or "" for h in hits}
                ev = "\n".join(f"{cid}: {t[:LIM['evidence_chars_per_chunk']]}" for cid, t in chunks.items()
                               )[: LIM["max_evidence_chars"]]
                out = await ask("fill_one", Fill, sentence=sentence, resolved=dumps(resolved),
                                slot=dumps({mention: question}), evidence=ev)
            except Exception as e:
                errors.append(f"A3.fill[{mention}]: {root_cause(e)}")
                continue
            if not out.resolution:
                dbg(f"round {round_i} {mention!r}: model said null (follow_up={out.follow_up_query!r})")
                if out.follow_up_query:
                    pending[mention] = out.follow_up_query
                continue
            bad_reason = valid_resolution(mention, out.resolution)
            if bad_reason is not None:
                dbg(f"round {round_i} {mention!r}: REJECTED ({bad_reason}) -> {out.resolution!r}")
                continue
            cid = grounded_chunk(out, chunks, mention, sentence)
            if cid is None:                           # quote missing or off topic -> reject, stay unresolved
                dbg(f"round {round_i} {mention!r}: REJECTED ungrounded {out.resolution!r} quote={out.evidence_quote!r}")
                continue
            dbg(f"round {round_i} {mention!r}: ACCEPTED -> {out.resolution!r} (chunk {cid})")
            resolved[mention], cites[mention] = out.resolution.strip(), cid
            pending.pop(mention)

    # two different mentions with the same answer cannot both be right -> leave both for A4,
    # unless one of them is a back-reference ("the old one"), which is allowed to share its antecedent's answer
    by_val: dict[str, list[str]] = {}
    for m, r in resolved.items():
        by_val.setdefault(norm(r), []).append(m)
    for ms in by_val.values():
        if len(ms) > 1 and not any(ANAPHOR.search(m) for m in ms):
            dbg("duplicate answer, dropping:", ms)
            for m in ms:
                resolved.pop(m, None)
                cites.pop(m, None)

    modified, applied = substitute(sentence, resolved)
    resolved = {m: r for m, r in resolved.items() if m in applied}
    unresolved = [m for m in order if m not in resolved]
    dbg("resolved:", resolved, "| unresolved:", unresolved)
    if not resolved:
        return {
            **base,
            "entities": [Entity(mention=m, resolved=None) for m in order],
            "a3_unresolved": unresolved,
            **({"errors": errors} if errors else {}),
        }

    triples: list[LTriple] = []
    try:
        triples = (await ask("triples", TripleList, sentence=modified)).triples
    except Exception as e:
        errors.append(f"A3.triples: {root_cause(e)}")
    return {
        "given_sentence": sentence,
        "modified_sentence": modified,                # built in code from the original sentence
        "chunk_ids": list(dict.fromkeys(cites[m] for m in resolved)),
        "clarification": "",
        "entities": [Entity(mention=m, resolved=resolved.get(m)) for m in order],   # unresolved stay None
        "triples": [Triple(subj=t.subj, rel=t.rel, obj=t.obj) for t in triples],
        "a3_unresolved": unresolved,
        **({"errors": errors} if errors else {}),
    }


# ---------------------------------------------------------------- graph
def build_a3():
    g = StateGraph(StageAState)
    for name, fn in (("make_queries", make_queries), ("crawl", crawl), ("ingest", ingest), ("resolve", resolve)):
        g.add_node(name, fn)
    g.add_edge(START, "make_queries")
    g.add_conditional_edges("make_queries", lambda s: "resolve" if s.a3_skipped_crawl else "crawl",
                            {"crawl": "crawl", "resolve": "resolve"})
    g.add_edge("crawl", "ingest"); g.add_edge("ingest", "resolve"); g.add_edge("resolve", END)
    return g.compile()


a3 = build_a3()

if __name__ == "__main__":
    async def _main():
        q = os.getenv("A3_SENTENCE", "The government replaced MGNREGA with a new scheme.")
        out = await a3.ainvoke(StageAState(session_id="dev", query=q))
        print(json.dumps(out, indent=2, ensure_ascii=False, default=lambda o: o.model_dump()))
        await close()
    asyncio.run(_main())