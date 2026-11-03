"""Standalone test for the A2 node (intent + evaluator-optimizer loop).

Run from anywhere:  python test/a2_test.py
Needs: Ollama running with gemma4:e2b and a .env in the project root.
A2 does not use MCP, so no tunnel is needed.
"""
import asyncio
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")  # before any langchain / backend import

from backend.nodes import a2  # noqa: E402
from backend.state import StageAState as  State  # noqa: E402

CASES = [
    # (query, expected intent)
    ("Prove that the government did not replace MGNREGA.", "challenging"),
    ("Did the government replace MGNREGA with a new scheme?", "neutral"),
    ("Was replacing MGNREGA a fair decision?", "evaluative"),
    ("I think this news about the scheme is fake, show me why.", "challenging"),
]

results = []


def report(name: str, ok: bool, detail: str = ""):
    results.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")


async def trace_loop(query: str):
    """Mirror of the loop in a2.run, printing every round."""
    feedback = "none"
    for i in range(1, a2.MAX_ROUNDS + 1):
        guess = await a2.generate.ainvoke({"query": query, "memory": "{}", "feedback": feedback})
        verdict = await a2.evaluate.ainvoke(
            {"query": query, "intent": guess.intent,
             "confidence": guess.confidence, "reason": guess.reason})
        print(f"  round {i}: {guess.intent} ({guess.confidence}) | {guess.reason}")
        print(f"           evaluator: {verdict.accept} {verdict.feedback}")
        if verdict.accept == "yes":
            return
        feedback = verdict.feedback


async def main():
    for query, expected in CASES:
        print(f"\nQ: {query}")
        try:
            await trace_loop(query)

            out = await a2.run(State(session_id="a2-test", query=query), {"run_name": "a2_test_node"})
            print(f"  node -> intent={out['intent']} conf={out['intent_conf']} errors={out.get('errors')}")

            valid = out["intent"] in ("challenging", "neutral", "evaluative") and 0 <= out["intent_conf"] <= 1
            report("valid output", valid)
            report(f"intent == {expected}", out["intent"] == expected, f"got={out['intent']}")
        except Exception as e:
            traceback.print_exc()
            report(f"node: {query!r}", False, repr(e))

    print(f"\n{sum(results)}/{len(results)} passed")


asyncio.run(main())