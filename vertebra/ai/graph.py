"""LangGraph prospect-processing pipeline.

The graph wires the engine's stages into a single inspectable, checkpointable
flow that workers execute per company:

    enrich → score → route ─┬→ channel_a (automated email)
                            └→ channel_b (Josias high-touch)

State is a plain ``TypedDict`` so every node is independently testable and the
graph can later be persisted with a LangGraph checkpointer without refactor.
LangGraph itself is imported lazily so lightweight consumers (tests, console
API routes) can import the nodes without the dependency present.
"""

from __future__ import annotations

from typing import Any, TypedDict

from vertebra.config.settings import get_settings
from vertebra.ai.scorer import QuoteLeakageScorer, ScoringInput
from vertebra.enrichment.engine import EnrichmentEngine
from vertebra.logging_conf import get_logger
from vertebra.models.domain import Channel, CompanyRecord, DispatchDecision, Prospect
from vertebra.models.errors import EnrichmentError

log = get_logger("ai.graph")


class ProspectState(TypedDict, total=False):
    """Shared graph state — keys written by each node."""

    company: CompanyRecord
    contacts: list[Any]
    prospect: Prospect | None
    scoring_input: ScoringInput | None
    error: str | None
    traced_at: list[str]


def make_initial_state(company: CompanyRecord, contacts: list[Any] | None = None) -> ProspectState:
    return {"company": company, "contacts": contacts or [], "traced_at": []}


# --------------------------------------------------------------------------- #
# Nodes
# --------------------------------------------------------------------------- #


async def enrich_node(state: ProspectState) -> dict[str, Any]:
    """Permutation + SMTP verification + CASL evaluation."""
    engine = EnrichmentEngine()
    try:
        prospect = await engine.enrich(state["company"], state.get("contacts") or [])
    except EnrichmentError as exc:
        return {"prospect": None, "error": str(exc)}
    return {"prospect": prospect}


def to_scoring_input(state: ProspectState) -> ScoringInput:
    """Project enriched prospect state onto the scorer's input contract."""
    prospect = state.get("prospect")
    company = state["company"]
    return ScoringInput(
        prospect_id=prospect.id if prospect else company.name,
        company_name=company.name,
        vertical=company.vertical.value if company.vertical else None,
        region=company.region.value if company.region else None,
        revenue_estimate_usd=company.revenue_estimate_usd,
        employee_count=company.employee_count,
        detected_erp=company.detected_erp,
        legacy_portal=_portal_hint(company),
        notes=(company.raw_excerpt or None),
    )


def _portal_hint(company: CompanyRecord) -> str | None:
    """Legacy-portal signal extracted from the raw directory excerpt."""
    text = (company.raw_excerpt or "").lower()
    for hint in ("customer portal", "b2b portal", "ordering portal", "rfq portal", "login to order"):
        if hint in text:
            return hint
    return None


async def score_node(state: ProspectState) -> dict[str, Any]:
    """Quote Leakage Vulnerability scoring (Claude primary, rubric fallback)."""
    payload = to_scoring_input(state)
    scorer = QuoteLeakageScorer()
    result = await scorer.score(payload)
    prospect = state.get("prospect")
    if prospect is not None:
        prospect.score = result
    return {"scoring_input": payload, "prospect": prospect}


async def route_node(state: ProspectState) -> dict[str, Any]:
    """Threshold + CASL routing between Channel A and Channel B."""
    settings = get_settings().policy
    prospect = state.get("prospect")
    if prospect is None or prospect.score is None:
        return {"prospect": prospect}

    if prospect.score.qlv_score >= settings.channel_a_min_score:
        channel = Channel.AUTOMATED_EMAIL
        reasons = [
            f"qlv {prospect.score.qlv_score} >= channel_a_min_score {settings.channel_a_min_score}"
        ]
    else:
        channel = Channel.HIGH_TOUCH
        reasons = [
            f"qlv {prospect.score.qlv_score} < channel_a_min_score {settings.channel_a_min_score}: "
            "high-touch craft beats automation at this score"
        ]
    if prospect.casl_scope:
        reasons.append("CASL scope detected: compliance footer + one-click unsubscribe enforced")

    prospect.dispatch = DispatchDecision(
        prospect_id=prospect.id, channel=channel, casl_scope=prospect.casl_scope, reasons=reasons
    )
    log.info(
        "routed",
        company=prospect.company.name,
        channel=channel.value,
        qlv=prospect.score.qlv_score,
    )
    return {"prospect": prospect}


def route_branch(state: ProspectState) -> str:
    """Conditional edge function: which dispatch node to enter."""
    prospect = state.get("prospect")
    if prospect is None:
        return "__end__"
    decision = prospect.dispatch
    if decision is None:
        return "__end__"
    return "channel_a" if decision.channel is Channel.AUTOMATED_EMAIL else "channel_b"


# Channel terminal nodes are injected by the dispatch package to avoid a
# circular import; they mutate the DispatchDecision with final payloads.


def channel_a_placeholder(state: ProspectState) -> dict[str, Any]:  # pragma: no cover
    raise NotImplementedError("injected by vertebra.dispatch.router.build_channel_nodes")


def channel_b_placeholder(state: ProspectState) -> dict[str, Any]:  # pragma: no cover
    raise NotImplementedError("injected by vertebra.dispatch.router.build_channel_nodes")


# --------------------------------------------------------------------------- #
# Graph assembly
# --------------------------------------------------------------------------- #


def build_prospect_graph(
    channel_a_node=None,
    channel_b_node=None,
):
    """Compile the prospect graph. Channel nodes default to dispatch impls."""
    try:
        from langgraph.graph import END, StateGraph
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "langgraph is required to build the pipeline graph: pip install langgraph"
        ) from exc

    if channel_a_node is None or channel_b_node is None:
        from vertebra.dispatch.router import build_channel_nodes

        channel_a_node, channel_b_node = build_channel_nodes()

    graph = StateGraph(ProspectState)
    graph.add_node("enrich", enrich_node)
    graph.add_node("score", score_node)
    graph.add_node("route", route_node)
    graph.add_node("channel_a", channel_a_node)
    graph.add_node("channel_b", channel_b_node)

    graph.set_entry_point("enrich")
    graph.add_edge("enrich", "score")
    graph.add_edge("score", "route")
    graph.add_conditional_edges("route", route_branch, {"channel_a": "channel_a", "channel_b": "channel_b", "__end__": END})
    graph.add_edge("channel_a", END)
    graph.add_edge("channel_b", END)

    return graph.compile()
