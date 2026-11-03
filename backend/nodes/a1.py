"""A1 - session memory.

Three pop_os MCP stores (markdown notes, Qdrant, graph) are checked in parallel.
gemma4:e2b judges each one; hits are merged into state.memory.
Async node: call the graph with ainvoke / astream.
"""
import json
import os
import re
from pathlib import Path
from typing import Literal

from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableConfig, RunnableLambda, RunnableParallel
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_ollama import ChatOllama
from pydantic import BaseModel, Field

MCP_URL = os.getenv("POP_OS_MCP_URL", "https://noninflammable-nonviolably-tula.ngrok-free.dev/mcp")
OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")  # Docker: host.docker.internal
PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompt_templates" / "a1.json"

QDRANT_SOURCE = "stagea_a1"   # source tag A1 was stored under in Qdrant
NOTES_MARKER = "stagea-a1"    # part of the A1 markdown note file name
MAX_CHARS = 6000

TOOLS: dict = {}  # filled once per run


# ---------- pydantic ----------
class Match(BaseModel):
    entity: str = Field(description="entity or claim subject, as named in the query")
    fact: str = Field(description="one short fact taken from the retrieved text")


class DBCheck(BaseModel):
    already_present_in_db: Literal["yes", "no"]
    matches: list[Match] = []


# ---------- MCP ----------
async def load_tools():
    client = MultiServerMCPClient(
        {"pop_os": {"url": MCP_URL, "transport": "streamable_http",
                    "headers": {"ngrok-skip-browser-warning": "true"}}}
    )
    return {t.name: t for t in await client.get_tools()}


def text(result) -> str:
    if isinstance(result, tuple):
        result = result[0]
    if isinstance(result, list):
        return "\n".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in result)
    return str(result)


async def from_notes(query: str) -> str:
    listing = text(await TOOLS["notes_list"].ainvoke({"limit": 100}))
    names = [n for n in dict.fromkeys(re.findall(r"[\w.\-]+\.md", listing)) if NOTES_MARKER in n]
    docs = [text(await TOOLS["notes_read"].ainvoke({"filename": n})) for n in names[-3:]]
    return "\n\n".join(docs)[:MAX_CHARS]


async def from_qdrant(query: str) -> str:
    out = text(await TOOLS["memory_search"].ainvoke(
        {"query": query, "limit": 5, "source": QDRANT_SOURCE}))
    return out[:MAX_CHARS]


GRAPH_CYPHER = (
    "MATCH (a)-[r:FACT]->(b) WHERE r.valid_until IS NULL "
    "AND any(k IN $kws WHERE toLower(a.name) CONTAINS k OR toLower(b.name) CONTAINS k) "
    "RETURN a.name AS subject, r.predicate AS predicate, b.name AS object LIMIT 25"
)


async def from_graph(query: str) -> str:
    kws = [w for w in dict.fromkeys(re.findall(r"[a-z0-9]{4,}", query.lower()))][:8]
    out = text(await TOOLS["graph_read_cypher"].ainvoke(
        {"query": GRAPH_CYPHER, "params": {"kws": kws}}))
    return out[:MAX_CHARS]


# ---------- chains ----------
def load_prompt() -> ChatPromptTemplate:
    spec = json.loads(PROMPT_PATH.read_text(encoding="utf-8"))
    return ChatPromptTemplate.from_messages([(m["role"], m["template"]) for m in spec["messages"]])


def branch(name: str, label: str, retrieve, judge):
    async def fetch(inp: dict) -> dict:
        return {"query": inp["query"], "source": label, "retrieved": await retrieve(inp["query"])}

    return (RunnableLambda(fetch) | judge).with_config(run_name=f"a1_{name}", tags=["stage_a", "a1", name])


llm = ChatOllama(model="gemma4:e2b", base_url=OLLAMA_URL, temperature=0)
judge = load_prompt() | llm.with_structured_output(DBCheck, method="json_schema")

parallel = RunnableParallel(
    notes=branch("notes", "markdown notes", from_notes, judge),
    qdrant=branch("qdrant", "Qdrant", from_qdrant, judge),
    graph=branch("graph", "graph database", from_graph, judge),
).with_config(run_name="a1_parallel")


# ---------- node ----------
async def run(state, config: RunnableConfig = None) -> dict:
    TOOLS.update(await load_tools())
    checks = await parallel.ainvoke({"query": state.query}, config)

    memory = dict(state.memory)
    found = False
    for source, check in checks.items():
        if check.already_present_in_db != "yes":
            continue
        for m in check.matches:
            found = True
            entry = memory.setdefault(m.entity, {"facts": [], "sources": []})
            if m.fact not in entry["facts"]:
                entry["facts"].append(m.fact)
            if source not in entry["sources"]:
                entry["sources"].append(source)

    return {"already_present_in_db": "yes" if found else "no", "memory": memory}