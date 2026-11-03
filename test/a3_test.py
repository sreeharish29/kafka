# a3_test.py
"""
One-sentence, full-pipeline test for a3.py (real MCP, real LLM, real or cached search_fetch).

    python a3_test.py                                                   # live crawl, fresh sentence #1
    A3_CASE=2 python a3_test.py                                         # live crawl, fresh sentence #2 (or 3)
    A3_SENTENCE="your sentence" python a3_test.py                       # any sentence
    A3_DEBUG=1 python a3_test.py                                        # show accept/reject/drop reasons
    A3_KEEP=1 python a3_test.py                                         # keep the temporary Qdrant chunks
    A3_ARTICLES_JSON=articles.json A3_CASE=4 A3_DEBUG=1 python a3_test.py   # fast offline crawl mode
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.nodes import a3
from backend.state import StageAState

# None of these topics appear in the prompts in a3.json.
# Case 4 matches your sample Azam Khan articles.json for instant offline testing.
FRESH = [
    "The Indian government replaced MGNREGA with VBG-RAMG Yojana and reduced person days by 40%,because India's richest man's brother controls the government.",
    "The RBI governor said the central bank will keep the repo rate unchanged because inflation is under control.",
    "The airline cancelled hundreds of flights and the regulator ordered an inquiry.",
    "The SP leader walked out of the district jail after the apex court granted him interim bail in the cheating case.",
]
CASE = int(os.getenv("A3_CASE", "1"))
SENTENCE = os.getenv("A3_SENTENCE") or FRESH[(CASE - 1) % len(FRESH)]
KEEP = os.getenv("A3_KEEP") == "1"
ARTICLES_JSON = os.getenv("A3_ARTICLES_JSON", "").strip()


def dump(items):
    return [x.model_dump() if hasattr(x, "model_dump") else x for x in items]


def leak_check(sentence: str) -> list[str]:
    """Distinctive words of the sentence that also occur in the a3.json prompts (few-shot leakage)."""
    prompts = json.dumps({k: v for k, v in a3.CFG.items() if k != "config"}).lower()
    words = {w for w in re.findall(r"[A-Za-z][A-Za-z\-]{3,}", sentence) if w[0].isupper() or w.isupper()}
    return sorted(w for w in words if w.lower() in prompts)


def install_offline_fixture(json_path: str) -> int:
    """Monkey-patch a3.run_pipeline to load articles from a local JSON file instead of crawling."""
    path = Path(json_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"A3_ARTICLES_JSON file not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))

    async def _fake_pipeline(queries=None, *args, **kwargs):
        print(f"offline mode : loaded {len(data)} cached articles from {path.name} (skipped live search/crawl)")
        return data

    a3.run_pipeline = _fake_pipeline
    return len(data)


async def preview_cleaned_chunks(json_path: str):
    """Print how clean_article() + chunk_text() transform the cached JSON before hitting Qdrant."""
    path = Path(json_path).expanduser().resolve()
    data = json.loads(path.read_text(encoding="utf-8"))
    print("\n--- Clean & Chunk Preview (first 2 articles) ---")
    for url, art in list(data.items())[:2]:
        raw = (art.get("text") or "").strip()
        cleaned = a3.clean_article(raw)
        chunks = a3.chunk_text(raw)
        print(f"URL          : {url[:85]}")
        print(f"raw chars    : {len(raw)} -> cleaned chars: {len(cleaned)} ({len(chunks)} chunks)")
        if chunks:
            print(f"last chunk   : {chunks[-1][-160:]!r}")
    print("------------------------------------------------\n")


async def main():
    out, rid = {}, None
    leaks = leak_check(SENTENCE)
    print(
        f"leak check   : {'CLEAN, no distinctive words found in the prompts' if not leaks else 'WARNING shared with prompts: ' + str(leaks)}"
    )

    if ARTICLES_JSON:
        install_offline_fixture(ARTICLES_JSON)
        if os.getenv("A3_DEBUG"):
            await preview_cleaned_chunks(ARTICLES_JSON)

    try:
        out = await a3.a3.ainvoke(StageAState(session_id="a3_test", query=SENTENCE))
        rid = out.get("a3_run_id")

        modified, cited = out["modified_sentence"], out["chunk_ids"]
        changed = modified.strip() != SENTENCE.strip()
        verdict = "RESOLVED" if changed and cited else "PARTIAL" if changed else "NOT RESOLVED"

        print(f"\ninput        : {SENTENCE}")
        print(f"modified     : {modified}")
        print(f"verdict      : {verdict}")
        print(f"queries      : {out['a3_queries']}")
        print(f"ingested     : {out.get('a3_ingested_articles')} articles")
        print(f"cited chunks : {cited}")
        print(f"unresolved   : {out.get('a3_unresolved')}")
        print(f"entities     : {dump(out['entities'])}")
        print(f"triples      : {dump(out['triples'])}")
        print(f"errors       : {out.get('errors')}")

        ok = (
            (not out.get("errors"))
            and out.get("a3_skipped_crawl") is False
            and out.get("a3_ingested_articles", 0) > 0
            and out.get("clarification") in ("", None)
        )
        print(
            f"\npipeline health: {'OK' if ok else 'PROBLEM'} "
            "(no errors, crawl ran, articles ingested, clarification empty)"
        )
    finally:
        if rid and not KEEP:
            try:
                res = await a3.call("memory_delete_by_filter", source=a3.run_source(rid))
                print(f"cleanup      : {res[:150]}")
            except Exception as e:
                print(f"cleanup FAILED: {a3.root_cause(e)}  (run {rid}, source {a3.run_source(rid)})")
        elif rid:
            print(f"cleanup      : skipped (A3_KEEP=1), run {rid}")
        await a3.close()


if __name__ == "__main__":
    asyncio.run(main())