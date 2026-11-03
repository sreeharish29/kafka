from langgraph.graph import StateGraph, START, END
from backend.state import State
from backend.nodes import a1, a2, a3, a4, a5, a7, a6, a8

ORDER = [("a1", a1), ("a2", a2), ("a3", a3), ("a4", a4),
         ("a5", a5), ("a7", a7), ("a6", a6), ("a8", a8)]

def build(checkpointer):
    g = StateGraph(State)
    for name, mod in ORDER:
        g.add_node(name, mod.run)
    names = [START] + [n for n, _ in ORDER] + [END]
    for a, b in zip(names, names[1:]):
        g.add_edge(a, b)
    return g.compile(checkpointer=checkpointer)