"""A2 - intent classification with an evaluator-optimizer loop.

gemma4:e2b classifies the query as challenging / neutral / evaluative.
The same model then checks that answer. If it is rejected, the feedback goes back
to the classifier and it tries again, up to MAX_ROUNDS.
Intent only shapes interaction and retrieval. It never feeds a truth verdict.
Async node: call the graph with ainvoke / astream.
"""
import json
import os
from pathlib import Path
from typing import Literal

from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableConfig
from langchain_ollama import ChatOllama
from pydantic import BaseModel, Field

OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")  # Docker: host.docker.internal
PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompt_templates" / "a2.json"
MAX_ROUNDS = 3
MEMORY_CHARS = 1500


# ---------- pydantic ----------
class IntentGuess(BaseModel):
    intent: Literal["challenging", "neutral", "evaluative"]
    confidence: float = Field(ge=0, le=1)
    reason: str


class Verdict(BaseModel):
    accept: Literal["yes", "no"]
    feedback: str = ""


# ---------- chains ----------
def load_prompt(key: str) -> ChatPromptTemplate:
    spec = json.loads(PROMPT_PATH.read_text(encoding="utf-8"))
    return ChatPromptTemplate.from_messages([(m["role"], m["template"]) for m in spec[key]["messages"]])


llm = ChatOllama(model="gemma4:e2b", base_url=OLLAMA_URL, temperature=0)

generate = (load_prompt("generator") | llm.with_structured_output(IntentGuess, method="json_schema")
            ).with_config(run_name="a2_generate", tags=["stage_a", "a2"])
evaluate = (load_prompt("evaluator") | llm.with_structured_output(Verdict, method="json_schema")
            ).with_config(run_name="a2_evaluate", tags=["stage_a", "a2"])


# ---------- node ----------
async def run(state, config: RunnableConfig = None) -> dict:
    memory = json.dumps(state.memory, ensure_ascii=False)[:MEMORY_CHARS]
    feedback = "none"
    accepted = False

    for _ in range(MAX_ROUNDS):
        guess = await generate.ainvoke(
            {"query": state.query, "memory": memory, "feedback": feedback}, config)
        verdict = await evaluate.ainvoke(
            {"query": state.query, "intent": guess.intent,
             "confidence": guess.confidence, "reason": guess.reason}, config)
        if verdict.accept == "yes":
            accepted = True
            break
        feedback = verdict.feedback

    update = {"intent": guess.intent, "intent_conf": guess.confidence}
    if not accepted:
        update["errors"] = [f"A2: evaluator did not accept after {MAX_ROUNDS} rounds, using last guess"]
    return update