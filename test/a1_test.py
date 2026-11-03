"""Standalone test for the A1 node.

Run from anywhere:  python test/a1_test.py
Needs: Ollama running with gemma4:e2b, the pop_os MCP reachable, and a .env in the project root.
"""
import asyncio
import json
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")  # before any langchain / backend import

from backend.nodes import a1  # noqa: E402
from backend.state import StageAState  as State # noqa: E402

CASES = [
    # (query, expected already_present_in_db)
    ("What is A1 session memory in Stage A?", "yes"),
    ("Did Zenith Ltd win the tender?", "no"),
]

results = []


def report(name: str, ok: bool, detail: str = ""):
    results.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")


async def main():
    # 1. MCP reachable and the tools A1 needs are there
    tools = await a1.load_tools()
    needed = ["notes_list", "notes_read", "memory_search", "graph_read_cypher"]
    missing = [n for n in needed if n not in tools]
    report("MCP tools", not missing, f"missing={missing} have={sorted(tools)}")
    if missing:
        return
    a1.TOOLS.update(tools)

    # 2. each retriever on its own (no model involved)
    probe = "A1 session memory stage A"
    for name, fn in [("notes", a1.from_notes), ("qdrant", a1.from_qdrant), ("graph", a1.from_graph)]:
        try:
            out = await fn(probe)
            report(f"retrieve {name}", bool(out.strip()), f"{len(out)} chars")
        except Exception as e:
            report(f"retrieve {name}", False, repr(e))

    # 3. three parallel gemma checks, then the full node
    for query, expected in CASES:
        print(f"\nQ: {query}")
        try:
            checks = await a1.parallel.ainvoke({"query": query}, {"run_name": "a1_test"})
            for store, c in checks.items():
                print(f"  {store:7} -> {c.already_present_in_db}  {[m.model_dump() for m in c.matches]}")

            state = State(session_id="a1-test", query=query)
            out = await a1.run(state, {"run_name": "a1_test_node"})
            print("  memory:", json.dumps(out["memory"], indent=2))
            report(f"node: {query!r}", out["already_present_in_db"] == expected,
                   f"got={out['already_present_in_db']} expected={expected}")
        except Exception as e:
            traceback.print_exc()  # shows which file and line raised it
            report(f"node: {query!r}", False, repr(e))

    print(f"\n{sum(results)}/{len(results)} passed")


asyncio.run(main())