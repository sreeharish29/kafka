#!/usr/bin/env python3
"""
Stage A3 - Search & Fetch (importable; later called from FastAPI / a LangGraph node).

Truthful overlapping pipeline, 1 thread / 1 event loop:

    search jobs (NewsData + MCP, one job per query x source)
          |  every URL is queued the moment its job finishes
          v
    asyncio.Queue  -->  6 crawl workers (one shared browser)

Search and crawl overlap, and every step is reported through `emit(...)`
so a frontend can draw the real timeline.

Usage
-----
    results = await run_pipeline(["query one", "query two"])             # from LangGraph / FastAPI
    python search_fetch.py "query one" "query two"                       # from the CLI

    pip install requests langchain-mcp-adapters crawl4ai python-dotenv
    python -m playwright install chromium
    export NEWSDATA_API_KEY=pub_...      # or put it in ../.env
"""
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
from crawl4ai.content_filter_strategy import PruningContentFilterLXML
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
from langchain_mcp_adapters.client import MultiServerMCPClient

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
load_dotenv()

DEFAULT_QUERIES = [
    "Azam Khan",
    "Azam Khan Supreme Court",
    "Azam Khan ED detention Rampur Jail",
    "Azam Khan moves Supreme Court against ED detention outside Rampur Jail",
]
SKIP_DOMAINS = {"espncricinfo.com", "cricbuzz.com", "cricketpakistan.com.pk", "geosuper.tv"}

MAX_URLS = 120
MAX_CHARS = 20_000
N_WORKERS = 6          # concurrent crawl consumers (the 6 lanes)
SEARCH_LIMIT = 6       # max concurrent search jobs
QUEUE_SIZE = 50        # backpressure for the producer side
CRAWL_TIMEOUT = 60     # seconds per page


# --------------------------------------------------------------------------
# Event emitter (feeds the frontend / replay file)
# --------------------------------------------------------------------------
class Emitter:
    """emit("crawl_done", worker=2, url=...) -> {"t": secs_since_start, "type": ..., ...}

    sinks are plain functions taking one event dict, e.g. a JSONL writer or
    `lambda ev: ws_queue.put_nowait(ev)` for a WebSocket broadcaster.
    """

    def __init__(self, sinks=()):
        self.t0 = time.monotonic()
        self.sinks = list(sinks)
        self.events = []

    def __call__(self, type, **data):
        ev = {"t": round(time.monotonic() - self.t0, 3), "type": type, **data}
        self.events.append(ev)
        for sink in self.sinks:
            try:
                sink(ev)
            except Exception as e:                      # a bad sink must never break the crawl
                print(f"  emit sink error: {e!r}")


def jsonl_sink(path):
    f = open(path, "w", encoding="utf-8", buffering=1)  # line-buffered: safe on Ctrl+C

    def write(ev):
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")

    return write


# --------------------------------------------------------------------------
# Search helpers
# --------------------------------------------------------------------------
def newsdata(query):
    """Blocking (requests). Always call through asyncio.to_thread."""
    r = requests.get("https://newsdata.io/api/1/latest", timeout=20, params={
        "apikey": os.environ["NEWSDATA_API_KEY"], "q": query,
        "language": "en", "category": "news"})
    if r.status_code != 200:
        raise RuntimeError(f"newsdata HTTP {r.status_code}")
    return [x["link"] for x in r.json().get("results") or [] if x.get("link")]


async def mcp_search(search, props, query):
    args = {"query": query, "freshness": "week", "category": "news", "max_results": 20}
    res = await search.ainvoke({k: v for k, v in args.items() if k == "query" or k in props})
    if isinstance(res, tuple):
        res = res[0]
    if isinstance(res, list):
        res = "\n".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in res)
    return re.findall(r"<(https?://[^>\s]+)>", str(res))


async def start_mcp_search():
    """Start free-search-mcp. Returns (tool, props) or (None, {}) if it can't start."""
    try:
        client = MultiServerMCPClient(
            {"search": {"command": "uvx", "args": ["free-search-mcp"], "transport": "stdio"}})
        search = next(t for t in await client.get_tools() if t.name == "search")
        schema = search.args_schema
        props = (schema if isinstance(schema, dict) else schema.model_json_schema()).get("properties", {})
        return search, props
    except Exception as e:
        print(f"  MCP unavailable, continuing with NewsData only: {e!r}")
        return None, {}


# --------------------------------------------------------------------------
# Producer side: one search job per (query, source)
# --------------------------------------------------------------------------
async def search_stage(queue, queries, search, props, found, seen, emit):
    sem = asyncio.Semaphore(SEARCH_LIMIT)
    # free-search-mcp uses ONE persistent Chrome profile: one MCP search at a time.
    mcp_lock = asyncio.Lock()

    async def handle(urls, source, job):
        """Filter, dedupe and queue URLs right away (this is what makes it overlap)."""
        new = 0
        for u in urls:
            domain = urlparse(u).netloc.replace("www.", "")
            if domain in SKIP_DOMAINS or "news.google.com/rss" in u:
                continue
            found.setdefault(u, set()).add(source)       # always record the source
            if u not in seen and len(seen) < MAX_URLS:
                seen.add(u)
                new += 1
                emit("url_queued", job=job, url=u)
                await queue.put(u)
        return new

    async def run_job(source, qi, query):
        job = f"{source}:{qi}"
        async with sem:
            emit("search_start", job=job, source=source, query=query)
            try:
                if source == "newsdata":
                    urls = await asyncio.to_thread(newsdata, query)
                else:
                    async with mcp_lock:                 # serialize MCP only
                        urls = await mcp_search(search, props, query)
            except Exception as e:
                print(f"  {source} {query!r}: {e!r}")
                emit("search_error", job=job, source=source, query=query, error=repr(e))
                return
        new = await handle(urls, source, job)
        emit("search_done", job=job, source=source, query=query,
             n_urls=len(urls), n_new=new)

    jobs = []
    for qi, q in enumerate(queries):
        jobs.append(run_job("newsdata", qi, q))
        if search is not None:
            jobs.append(run_job("mcp", qi, q))
    await asyncio.gather(*jobs)


# --------------------------------------------------------------------------
# Consumer side: crawl workers
# --------------------------------------------------------------------------
async def crawl_worker(wid, queue, crawler, cfg, results, emit):
    while True:
        url = await queue.get()
        try:
            if url is None:                              # sentinel
                return
            emit("crawl_start", worker=wid, url=url)
            try:
                r = await asyncio.wait_for(crawler.arun(url, config=cfg), timeout=CRAWL_TIMEOUT)
                text = ((r.markdown.fit_markdown or "").strip()
                        if r.success and r.markdown else "")[:MAX_CHARS]
                rec = {"url": url, "final_url": r.url, "success": bool(r.success),
                       "error": None if r.success else (r.error_message or "unknown"),
                       "title": (r.metadata or {}).get("title", ""), "text": text}
            except asyncio.TimeoutError:
                rec = {"url": url, "final_url": url, "success": False,
                       "error": f"timeout after {CRAWL_TIMEOUT}s", "title": "", "text": ""}
            except Exception as e:
                rec = {"url": url, "final_url": url, "success": False,
                       "error": repr(e), "title": "", "text": ""}
            results[url] = rec
            emit("crawl_done", worker=wid, url=url, ok=rec["success"],
                 chars=len(rec["text"]), error=rec["error"])
        finally:
            queue.task_done()


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------
async def run_pipeline(queries=None, emit=None, n_workers=N_WORKERS):
    """Search + crawl. Returns {url: {url, final_url, success, error, title, text, found_by}}.

    `emit` is an Emitter (or any callable emit(type, **data)); None = silent.
    """
    queries = queries or DEFAULT_QUERIES
    emit = emit or Emitter()
    found, seen, results = {}, set(), {}

    emit("run_start", queries=queries, workers=n_workers)
    search, props = await start_mcp_search()

    md = DefaultMarkdownGenerator(
        content_filter=PruningContentFilterLXML(threshold=0.4, threshold_type="fixed"))
    cfg = CrawlerRunConfig(cache_mode=CacheMode.BYPASS, markdown_generator=md)
    queue = asyncio.Queue(maxsize=QUEUE_SIZE)

    try:
        async with AsyncWebCrawler(config=BrowserConfig(headless=True)) as crawler:
            workers = [asyncio.create_task(crawl_worker(i, queue, crawler, cfg, results, emit))
                       for i in range(n_workers)]
            try:
                await search_stage(queue, queries, search, props, found, seen, emit)
            finally:                                     # always release the workers
                for _ in workers:
                    await queue.put(None)
                await asyncio.gather(*workers)
    finally:
        for url, rec in results.items():
            rec["found_by"] = sorted(found.get(url, []))
        ok = sum(r["success"] for r in results.values())
        emit("finished", total=len(results), ok=ok)
    return results


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
async def _cli():
    queries = sys.argv[1:] or DEFAULT_QUERIES
    emit = Emitter(sinks=[jsonl_sink("events.jsonl"),
                          lambda ev: print(f"  [{ev['t']:6.2f}s] {ev['type']}")])
    results = {}
    try:
        results = await run_pipeline(queries, emit)
    finally:
        with open("articles.json", "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        print(f"Saved {len(results)} articles to articles.json, events to events.jsonl")


if __name__ == "__main__":
    asyncio.run(_cli())