
"""Standalone A1 retrieval and output test.

Run from project root:
    python test/a1_test.py

Tests:
1. MCP tool availability
2. Individual notes, Qdrant and graph retrieval
3. Raw Qdrant response structure
4. Parallel LLM judgments
5. Complete A1 node output, including retrieved_chunks
6. JSON serializability of the returned state
"""

import asyncio
import json
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")

from backend.nodes import a1
from backend.state import StageAState as State


CASES = [
    ("What is A1 session memory in Stage A?", "yes"),
    ("Did Zenith Ltd win the tender?", "no"),
]

results = []


def report(name: str, ok: bool, detail: str = ""):
    results.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")


def print_json(title, value):
    print(f"\n{'=' * 25} {title} {'=' * 25}")
    try:
        print(json.dumps(value, indent=2, ensure_ascii=False, default=str))
    except Exception:
        print(repr(value))
    print("=" * (52 + len(title)))


def inspect_raw_qdrant(result):
    """Display the exact MCP return value without converting it to text."""

    print_json("RAW QDRANT RESPONSE", result)

    print("\nQDRANT RESPONSE TYPE:", type(result).__name__)

    if isinstance(result, dict):
        print("TOP-LEVEL KEYS:", list(result.keys()))

        for key, value in result.items():
            print(
                f"  {key}: type={type(value).__name__}, "
                f"length={len(value) if hasattr(value, '__len__') else 'N/A'}"
            )

    elif isinstance(result, list):
        print("RESULT COUNT:", len(result))

        for index, item in enumerate(result):
            print(f"\nITEM {index + 1}:")
            print("TYPE:", type(item).__name__)
            print_json(f"QDRANT ITEM {index + 1}", item)

    elif isinstance(result, tuple):
        print("TUPLE LENGTH:", len(result))

        for index, item in enumerate(result):
            print_json(f"TUPLE ITEM {index + 1}", item)

    else:
        print("RAW STRING/OBJECT:", str(result)[:12000])


async def main():
    print("\nA1 PIPELINE TEST")
    print("Project:", ROOT)

    # --------------------------------------------------
    # 1. MCP tools
    # --------------------------------------------------

    print("\n[1] Checking MCP connection")

    try:
        tools = await a1.load_tools()

        needed = [
            "notes_list",
            "notes_read",
            "memory_search",
            "graph_read_cypher",
        ]

        missing = [name for name in needed if name not in tools]

        report(
            "MCP tools",
            not missing,
            f"missing={missing}, available={sorted(tools)}",
        )

        if missing:
            return

        a1.TOOLS.update(tools)

    except Exception as error:
        traceback.print_exc()
        report("MCP connection", False, repr(error))
        return

    # --------------------------------------------------
    # 2. Individual retrieval tests
    # --------------------------------------------------

    print("\n[2] Testing individual retrievers")

    probe = "A1 session memory stage A"

    for name, function in [
        ("notes", a1.from_notes),
        ("qdrant", a1.from_qdrant),
        ("graph", a1.from_graph),
    ]:
        try:
            output = await function(probe)

            report(
                f"retrieve {name}",
                bool(output.strip()),
                f"characters={len(output)}",
            )

            if name == "qdrant":
                print_json("QDRANT TEXT RETURNED BY from_qdrant", output)

        except Exception as error:
            traceback.print_exc()
            report(f"retrieve {name}", False, repr(error))

    # --------------------------------------------------
    # 3. Inspect exact raw Qdrant MCP response
    # --------------------------------------------------

    print("\n[3] Inspecting raw Qdrant MCP response")

    try:
        raw_qdrant = await a1.TOOLS["memory_search"].ainvoke(
            {
                "query": probe,
                "limit": 5,
                "source": a1.QDRANT_SOURCE,
            }
        )

        inspect_raw_qdrant(raw_qdrant)

        report(
            "raw Qdrant response",
            raw_qdrant is not None,
            f"type={type(raw_qdrant).__name__}",
        )

    except Exception as error:
        traceback.print_exc()
        report("raw Qdrant response", False, repr(error))

    # --------------------------------------------------
    # 4. Parallel LLM judgments
    # --------------------------------------------------

    print("\n[4] Testing parallel LLM judgments")

    for query, expected in CASES:
        print(f"\nQUERY: {query}")

        try:
            checks = await a1.parallel.ainvoke(
                {"query": query},
                {"run_name": "a1_test"},
            )

            for store, result in checks.items():
                print(f"\nSTORE: {store}")

                # Supports both the original DBCheck output
                # and the proposed {retrieved, check} output.
                check = (
                    result["check"]
                    if isinstance(result, dict) and "check" in result
                    else result
                )

                print(
                    "STATUS:",
                    check.already_present_in_db,
                )

                print(
                    "MATCHES:",
                    json.dumps(
                        [match.model_dump() for match in check.matches],
                        indent=2,
                        ensure_ascii=False,
                    ),
                )

                if isinstance(result, dict) and "retrieved" in result:
                    print("RETRIEVED TEXT:")
                    print(str(result["retrieved"])[:12000])

            report(
                f"parallel: {query}",
                len(checks) == 3,
                f"branches={list(checks.keys())}",
            )

        except Exception as error:
            traceback.print_exc()
            report(f"parallel: {query}", False, repr(error))

    # --------------------------------------------------
    # 5. Full A1 node execution
    # --------------------------------------------------

    print("\n[5] Running complete A1 node")

    for query, expected in CASES:
        print(f"\nQUERY: {query}")

        try:
            state = State(
                session_id="a1-test",
                query=query,
            )

            output = await a1.run(
                state,
                {"run_name": "a1_test_node"},
            )

            print_json("COMPLETE A1 NODE OUTPUT", output)

            # Validate the existing output.
            report(
                f"node status: {query}",
                output.get("already_present_in_db") == expected,
                (
                    f"got={output.get('already_present_in_db')} "
                    f"expected={expected}"
                ),
            )

            report(
                f"node memory: {query}",
                isinstance(output.get("memory"), dict),
                f"entities={len(output.get('memory', {}))}",
            )

            # Validate original Qdrant retrieval preservation.
            chunks = output.get("retrieved_chunks")

            report(
                f"retrieved_chunks field: {query}",
                isinstance(chunks, list),
                f"type={type(chunks).__name__}",
            )

            if isinstance(chunks, list):
                print_json("PRESERVED QDRANT CHUNKS", chunks)

                for index, chunk in enumerate(chunks):
                    print(f"\nCHUNK {index + 1}")

                    if isinstance(chunk, dict):
                        print("SOURCE:", chunk.get("source"))
                        print("ID:", chunk.get("id"))
                        print("SCORE:", chunk.get("score"))
                        print("TEXT:", chunk.get("text", chunk.get("content", "")))
                    else:
                        print("VALUE:", chunk)

                report(
                    f"Qdrant chunk content: {query}",
                    bool(chunks) and all(
                        isinstance(chunk, dict)
                        and bool(
                            chunk.get("text")
                            or chunk.get("content")
                        )
                        for chunk in chunks
                    ),
                    f"count={len(chunks)}",
                )

            # Check whether the complete output can be serialized.
            try:
                json.dumps(output, default=str)
                serializable = True
            except Exception:
                serializable = False

            report(
                f"JSON serialization: {query}",
                serializable,
            )

        except Exception as error:
            traceback.print_exc()
            report(f"full A1 node: {query}", False, repr(error))

    # --------------------------------------------------
    # 6. Summary
    # --------------------------------------------------

    passed = sum(results)
    total = len(results)

    print("\n" + "=" * 60)
    print("A1 TEST SUMMARY")
    print("=" * 60)

    print(f"PASSED: {passed}")
    print(f"FAILED: {total - passed}")
    print(f"TOTAL:  {total}")

    print("\nOVERALL:", "PASS" if passed == total else "FAIL")


if __name__ == "__main__":
    asyncio.run(main())
