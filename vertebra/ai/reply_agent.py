"""Module 9 — Autonomous Closed-Loop Follow-Up Agent.

A LangGraph state machine over inbound prospect replies, powered by
Claude 3.5 Sonnet with forced tool schemas (same structured-output contract
as ``vertebra.ai.scorer``).

Loop
----
    inbound email → hygiene (strip quotes/signatures)
                  → classify (Claude) ──► INTERESTED ──────► book urgent call on
                  │                        │                 Josias' calendar
                  │                        ├─► OBJECTION_* ─► draft AI response
                  │                        │                 for human review
                  │                        ├─► SEND_INFO ───► draft info response
                  │                        │                 for human review
                  │                        ├─► OUT_OF_OFFICE► reschedule dispatch
                  │                        │                 past return date
                  │                        └─► NOT_INTERESTED► suppress sequence
                  └─► finalize: persist intent, drafts and outbox events

Intent classes: ``interested`` · ``out_of_office`` · ``send_information`` ·
``not_interested`` · ``objection_price`` · ``objection_erp`` · ``unknown``.

Autonomy boundary
-----------------
Interested replies book calendar time immediately (the operator asked for
speed); price/ERP objections and information requests are *drafted* and
queued for human review in ``agent_drafts`` — Claude never sends a rebuttal
on its own.

Usage
-----
    python -m vertebra.ai.reply_agent --process-pending --limit 25
    python -m vertebra.ai.reply_agent --reply-id <uuid>
"""

from __future__ import annotations

import json
import re
import uuid as uuid_mod
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph

from vertebra.config.settings import AnthropicSettings, ReplyAgentSettings, get_settings
from vertebra.db.outbox import OutboxStore
from vertebra.db.pool import Database
from vertebra.dispatch.calendar_sync import CalendarSync
from vertebra.logging_conf import get_logger
from vertebra.models.domain import (
    AgentActionType,
    AgentDecision,
    ReplyExtraction,
    ReplyIntent,
    utcnow,
)
from vertebra.models.errors import ReplyAgentError

log = get_logger("ai.reply_agent")

# --------------------------------------------------------------------------- #
# Inbound hygiene
# --------------------------------------------------------------------------- #

_QUOTE_MARKERS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^On .{0,200}wrote:\s*$", re.MULTILINE | re.IGNORECASE),
    re.compile(r"^-+\s*Original Message\s*-+\s*$", re.MULTILINE | re.IGNORECASE),
    re.compile(r"^From:\s.+$", re.MULTILINE),
    re.compile(r"^Sent from my (iPhone|Android).*$", re.MULTILINE | re.IGNORECASE),
)
_SIGNATURE_SPLIT = re.compile(r"\n--\s*\n")


def strip_quoted_text(body: str) -> str:
    """Cut quoted history and signatures so the classifier sees the fresh text."""
    cut = len(body)
    signature = _SIGNATURE_SPLIT.search(body)
    if signature:
        cut = min(cut, signature.start())
    for pattern in _QUOTE_MARKERS:
        match = pattern.search(body)
        if match:
            cut = min(cut, match.start())
    return body[:cut].strip()


# --------------------------------------------------------------------------- #
# Claude tool schemas (forced structured output)
# --------------------------------------------------------------------------- #

_CLASSIFY_TOOL_NAME = "record_reply_classification"
_CLASSIFY_TOOL: dict[str, Any] = {
    "name": _CLASSIFY_TOOL_NAME,
    "description": "Record the intent classification of an inbound prospect reply.",
    "input_schema": {
        "type": "object",
        "properties": {
            "intent": {
                "type": "string",
                "enum": [intent.value for intent in ReplyIntent],
            },
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "rationale": {"type": "string", "minLength": 10, "maxLength": 400},
            "return_date": {
                "type": "string",
                "description": "ISO-8601 date the sender returns, ONLY for out_of_office replies",
            },
            "objection_type": {
                "type": "string",
                "enum": ["price", "erp", "other"],
                "description": "Only for objection intents",
            },
            "requested_info": {
                "type": "string",
                "description": "What the sender asked for, ONLY for send_information",
            },
            "meeting_readiness": {"type": "boolean"},
            "delegate_contact": {
                "type": "string",
                "description": "Colleague address/name now owning the thread, if named",
            },
        },
        "required": ["intent", "confidence", "rationale"],
        "additionalProperties": False,
    },
}

_DRAFT_TOOL_NAME = "emit_outbound_draft"
_DRAFT_TOOL: dict[str, Any] = {
    "name": _DRAFT_TOOL_NAME,
    "description": "Emit a human-review draft reply for the prospect.",
    "input_schema": {
        "type": "object",
        "properties": {
            "subject": {"type": "string", "minLength": 4, "maxLength": 120},
            "body": {"type": "string", "minLength": 40, "maxLength": 1400},
        },
        "required": ["subject", "body"],
        "additionalProperties": False,
    },
}

_SYSTEM_CLASSIFY = (
    "You are Vertebra, Syntropic's inbound-reply classifier for cold outreach to US and Canada "
    "industrial distributors (PVF, Electrical, HVAC, Fluid Power).\n"
    "Intent definitions:\n"
    "- interested: explicit willingness to talk, book, or continue ('sure, call me', 'when can we talk?')\n"
    "- out_of_office: auto-responders or explicit absence; extract the return date when stated\n"
    "- send_information: wants deck, pricing sheet, references or specs before committing\n"
    "- not_interested: explicit decline, unsubscribe, or do-not-contact\n"
    "- objection_price: pushback on cost, ROI, budget cycles "
    "('too expensive', 'no budget this quarter')\n"
    "- objection_erp: pushback anchored to an incumbent system "
    "('our P21 handles that', 'we're mid-migration to SAP')\n"
    "- unknown: only when the reply is illegible\n"
    "Rules: ground the rationale in exact language from the reply; quote it. Never invent dates. "
    "Return the result only through the tool."
)

_SYSTEM_DRAFT = (
    "You draft executive-grade replies for Syntropic, which kills RFQ latency for industrial "
    "distributors. Voice: plain, concrete, zero hype, no exclamation marks, no 'I hope this finds "
    "you well', no discounting language.\n"
    "For objection_price: reframe using the cost of quote leakage (manual RFQ handling and unapplied "
    "vendor SPAs) rather than defending a price; one number maximum, from the prospect context only.\n"
    "For objection_erp: never disparage their ERP; position Syntropic as a bolt-on intelligence layer "
    "that ships in weeks on top of the system they already run.\n"
    "For send_information: answer with exactly what was requested and propose a 12-minute working call.\n"
    "Every draft ends with one clear next step. Return the draft only through the tool."
)


# --------------------------------------------------------------------------- #
# Claude clients
# --------------------------------------------------------------------------- #


class ReplyClassifier:
    """Claude 3.5 Sonnet classification with a forced tool schema."""

    def __init__(self, settings: AnthropicSettings | None = None) -> None:
        self._settings = settings or get_settings().anthropic
        self._client: Any | None = None

    def _anthropic(self) -> Any:
        if self._client is None:
            import anthropic  # lazy heavy import

            self._client = anthropic.AsyncAnthropic(
                api_key=self._settings.api_key.get_secret_value(),
                max_retries=self._settings.max_retries,
                timeout=self._settings.timeout_sec,
            )
        return self._client

    async def classify(
        self, *, lead_ctx: dict[str, Any], subject: str | None, body: str
    ) -> tuple[ReplyIntent, float, str, ReplyExtraction]:
        response = await self._anthropic().messages.create(
            model=self._settings.model,
            max_tokens=min(self._settings.max_tokens, 1200),
            temperature=0.1,
            system=_SYSTEM_CLASSIFY,
            tools=[_CLASSIFY_TOOL],
            tool_choice={"type": "tool", "name": _CLASSIFY_TOOL_NAME},
            messages=[{"role": "user", "content": _classify_prompt(lead_ctx, subject, body)}],
        )
        for block in response.content:
            if getattr(block, "type", None) == "tool_use" and block.name == _CLASSIFY_TOOL_NAME:
                return self._parse(block.input)
        raise ReplyAgentError(
            "classifier returned no tool_use block", context={"model": self._settings.model}
        )

    def _parse(self, data: dict[str, Any]) -> tuple[ReplyIntent, float, str, ReplyExtraction]:
        try:
            intent = ReplyIntent(str(data["intent"]))
        except (KeyError, ValueError) as exc:
            raise ReplyAgentError(f"unknown intent from classifier: {data.get('intent')!r}") from exc
        confidence = max(0.0, min(1.0, float(data.get("confidence", 0.0))))
        rationale = str(data.get("rationale", ""))

        return_date: datetime | None = None
        raw_return = data.get("return_date")
        if raw_return:
            try:
                return_date = datetime.fromisoformat(str(raw_return).replace("Z", "+00:00"))
            except ValueError:
                log.warning("classifier_return_date_unparseable", value=str(raw_return))
        objection_type = data.get("objection_type")
        if objection_type not in ("price", "erp", "other"):
            objection_type = None
        extraction = ReplyExtraction(
            return_date=return_date,
            objection_type=objection_type,  # type: ignore[arg-type]
            requested_info=data.get("requested_info") or None,
            meeting_readiness=bool(data.get("meeting_readiness", False)),
            delegate_contact=data.get("delegate_contact") or None,
        )
        return intent, confidence, rationale, extraction


class DraftWriter:
    """Claude 3.5 Sonnet draft generation for objection / info replies."""

    def __init__(
        self,
        *,
        settings: AnthropicSettings | None = None,
        agent_settings: ReplyAgentSettings | None = None,
    ) -> None:
        self._settings = settings or get_settings().anthropic
        self._agent = agent_settings or get_settings().reply_agent
        self._client: Any | None = None

    def _anthropic(self) -> Any:
        if self._client is None:
            import anthropic  # lazy heavy import

            self._client = anthropic.AsyncAnthropic(
                api_key=self._settings.api_key.get_secret_value(),
                max_retries=self._settings.max_retries,
                timeout=self._settings.timeout_sec,
            )
        return self._client

    async def draft(
        self, *, lead_ctx: dict[str, Any], intent: ReplyIntent, reply_body: str
    ) -> tuple[str, str]:
        user = (
            f"{_lead_block(lead_ctx)}\n\n"
            f"Detected intent: {intent.value}\n\n"
            f"Prospect's reply:\n\"\"\"\n{reply_body[:2000]}\n\"\"\"\n\n"
            f"Draft the reply now. Hard limit: {self._agent.draft_max_words} words."
        )
        response = await self._anthropic().messages.create(
            model=self._settings.model,
            max_tokens=min(self._settings.max_tokens, 1400),
            temperature=0.3,
            system=_SYSTEM_DRAFT,
            tools=[_DRAFT_TOOL],
            tool_choice={"type": "tool", "name": _DRAFT_TOOL_NAME},
            messages=[{"role": "user", "content": user}],
        )
        for block in response.content:
            if getattr(block, "type", None) == "tool_use" and block.name == _DRAFT_TOOL_NAME:
                subject = str(block.input.get("subject", "Re: your note")).strip()
                body = str(block.input.get("body", "")).strip()
                body = self._enforce_word_cap(body)
                if len(body) < 40:
                    raise ReplyAgentError("draft rejected: body too short", context={"intent": intent.value})
                return subject, body
        raise ReplyAgentError("drafter returned no tool_use block", context={"intent": intent.value})

    def _enforce_word_cap(self, body: str) -> str:
        cap = self._agent.draft_max_words
        words = body.split()
        if len(words) <= cap:
            return body
        log.warning("draft_word_cap_enforced", limit=cap, actual=len(words))
        return " ".join(words[:cap]).rstrip(",;") + "…"


def _lead_block(lead_ctx: dict[str, Any]) -> str:
    revenue = lead_ctx.get("revenue_estimate_usd")
    revenue_line = f"${revenue:,.0f}" if revenue else "unknown"
    lines = [
        f"Company: {lead_ctx.get('name') or 'unknown'}",
        f"Vertical: {lead_ctx.get('vertical') or 'unknown'}",
        f"Location: {lead_ctx.get('city') or 'unknown'}, {lead_ctx.get('country') or 'unknown'}",
        f"Revenue estimate: {revenue_line}",
        f"Detected ERP: {lead_ctx.get('detected_erp') or 'none detected'}",
        f"Quote portal type: {lead_ctx.get('quote_portal_type') or 'unknown'}",
        f"QLV score: {lead_ctx.get('qlv_score') or 'unscored'}",
    ]
    contact = lead_ctx.get("contact_name")
    if contact:
        lines.insert(1, f"Contact: {contact}")
    rationale = lead_ctx.get("score_rationale")
    if rationale:
        lines.append(f"Why they were pursued (excerpt): {str(rationale)[:300]}")
    return "\n".join(lines)


def _classify_prompt(lead_ctx: dict[str, Any], subject: str | None, body: str) -> str:
    return (
        f"{_lead_block(lead_ctx)}\n\n"
        f"Subject: {subject or '(none)'}\n\n"
        f"Reply body:\n\"\"\"\n{body[:3000]}\n\"\"\"\n\n"
        "Classify this reply now."
    )


# --------------------------------------------------------------------------- #
# LangGraph state + graph
# --------------------------------------------------------------------------- #


class ReplyGraphState(TypedDict, total=False):
    """Single shared state flowing through the agent loop."""

    reply_id: str
    prospect_id: str | None
    from_email: str
    subject: str
    body: str
    lead_ctx: dict[str, Any]
    intent: str
    confidence: float
    rationale: str
    extraction: dict[str, Any]
    actions: Annotated[list[str], lambda a, b: a + b]  # reducer: append-only
    draft_subject: str
    draft_body: str
    calendar_event_id: str
    calendar_event_link: str
    rescheduled_to: str
    review_required: bool
    error: str


def build_reply_graph(
    *,
    db: Database,
    outbox: OutboxStore,
    classifier: ReplyClassifier,
    drafter: DraftWriter,
    calendar: CalendarSync,
    settings: ReplyAgentSettings | None = None,
):
    """Compile the classify → act → finalize state machine."""
    agent_settings = settings or get_settings().reply_agent

    # --------------------------------------------------------------- classify
    async def classify_node(state: ReplyGraphState) -> dict[str, Any]:
        intent, confidence, rationale, extraction = await classifier.classify(
            lead_ctx=state["lead_ctx"], subject=state.get("subject"), body=state["body"]
        )
        return {
            "intent": intent.value,
            "confidence": confidence,
            "rationale": rationale,
            "extraction": json.loads(extraction.model_dump_json(exclude_none=True)),
        }

    # -------------------------------------------------------------- book call
    async def book_call_node(state: ReplyGraphState) -> dict[str, Any]:
        lead = state["lead_ctx"]
        try:
            created = await calendar.create_urgent_call_invite(
                company_name=str(lead.get("name") or "unknown company"),
                contact_name=str(lead.get("contact_name") or state["from_email"]),
                prospect_id=str(lead.get("id") or state.get("prospect_id") or "unsynced"),
                intent=state["intent"],
                reply_excerpt=state["body"][:400],
                qlv_score=lead.get("qlv_score"),
                audit_image_url=lead.get("audit_image_url"),
            )
        except Exception as exc:  # noqa: BLE001 - calendar outage must not kill the loop
            log.warning("urgent_call_booking_failed", error=str(exc))
            return {"error": f"calendar_booking_failed: {exc}"}
        return {
            "calendar_event_id": created["event_id"],
            "calendar_event_link": created.get("html_link"),
        }

    # ---------------------------------------------------------- draft replies
    async def draft_response_node(state: ReplyGraphState) -> dict[str, Any]:
        subject, body = await drafter.draft(
            lead_ctx=state["lead_ctx"],
            intent=ReplyIntent(state["intent"]),
            reply_body=state["body"],
        )
        return {
            "draft_subject": subject,
            "draft_body": body,
            "review_required": True,
        }

    # -------------------------------------------------------------- reschedule
    async def reschedule_node(state: ReplyGraphState) -> dict[str, Any]:
        extraction = state.get("extraction") or {}
        return_date = extraction.get("return_date")
        try:
            target = (
                datetime.fromisoformat(str(return_date))
                if return_date
                else utcnow() + timedelta(days=7)
            )
        except ValueError:
            target = utcnow() + timedelta(days=7)
        if target.tzinfo is None:
            target = target.replace(tzinfo=UTC)
        target += timedelta(hours=agent_settings.ooo_buffer_hours)

        prospect_uuid = uuid_mod.UUID(state["prospect_id"]) if state.get("prospect_id") else None
        if prospect_uuid is not None:
            async with db.pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        """
                        UPDATE dispatches
                           SET send_after = GREATEST(COALESCE(send_after, $2), $2),
                               updated_at = now()
                         WHERE prospect_id = $1 AND status = 'queued'
                        """,
                        prospect_uuid,
                        target,
                    )
                    await outbox.enqueue(
                        conn,
                        aggregate_type="reply",
                        aggregate_id=state["reply_id"],
                        event_type="reply.ooo_rescheduled",
                        payload={"rescheduled_to": target.isoformat()},
                    )
        return {"rescheduled_to": target.isoformat()}

    # ---------------------------------------------------------------- suppress
    async def suppress_node(state: ReplyGraphState) -> dict[str, Any]:
        prospect_uuid = uuid_mod.UUID(state["prospect_id"]) if state.get("prospect_id") else None
        if prospect_uuid is not None:
            async with db.pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        """
                        UPDATE dispatches
                           SET status = 'suppressed', updated_at = now()
                         WHERE prospect_id = $1 AND status = 'queued'
                        """,
                        prospect_uuid,
                    )
                    await outbox.enqueue(
                        conn,
                        aggregate_type="reply",
                        aggregate_id=state["reply_id"],
                        event_type="reply.sequence_suppressed",
                        payload={"reason": "not_interested"},
                    )
        return {}

    # ---------------------------------------------------------------- finalize
    async def finalize_node(state: ReplyGraphState) -> dict[str, Any]:
        """Persist the decision atomically: reply row, draft, outbox events."""
        actions: list[str] = []
        if state.get("calendar_event_id"):
            actions.append(AgentActionType.BOOK_URGENT_CALL.value)
        if state.get("draft_body"):
            actions.append(AgentActionType.DRAFT_FOR_REVIEW.value)
        if state.get("rescheduled_to"):
            actions.append(AgentActionType.RESCHEDULE_SEQUENCE.value)
        if "not_interested" == state.get("intent"):
            actions.append(AgentActionType.SUPPRESS_SEQUENCE.value)
        if state.get("error"):
            actions.append(AgentActionType.ESCALATE_HUMAN.value)

        async with db.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE inbound_replies
                       SET intent = $2, intent_confidence = $3, rationale = $4,
                           extracted = $5::jsonb, processed_at = now()
                     WHERE id = $1
                    """,
                    uuid_mod.UUID(state["reply_id"]),
                    state["intent"],
                    state.get("confidence"),
                    state.get("rationale"),
                    json.dumps(state.get("extraction") or {}, default=str),
                )
                if state.get("draft_body"):
                    await conn.execute(
                        """
                        INSERT INTO agent_drafts (reply_id, prospect_id, intent, subject, body)
                        VALUES ($1, $2, $3, $4, $5)
                        """,
                        uuid_mod.UUID(state["reply_id"]),
                        uuid_mod.UUID(state["prospect_id"]) if state.get("prospect_id") else None,
                        state["intent"],
                        state.get("draft_subject") or "(no subject)",
                        state["draft_body"],
                    )
                await outbox.enqueue(
                    conn,
                    aggregate_type="reply",
                    aggregate_id=state["reply_id"],
                    event_type="reply.classified",
                    payload={
                        "prospect_id": state.get("prospect_id"),
                        "intent": state["intent"],
                        "confidence": state.get("confidence"),
                        "actions": actions,
                        "review_required": bool(state.get("draft_body")),
                        "calendar_event_id": state.get("calendar_event_id"),
                        "rescheduled_to": state.get("rescheduled_to"),
                        "error": state.get("error"),
                    },
                )
        log.info(
            "reply_finalized",
            reply_id=state["reply_id"],
            intent=state["intent"],
            actions=actions,
        )
        state["actions"] = actions  # surface on the final state for AgentDecision
        return {"actions": actions}

    def _route(state: ReplyGraphState) -> str:
        return {
            ReplyIntent.INTERESTED.value: "book_call",
            ReplyIntent.OBJECTION_PRICE.value: "draft_response",
            ReplyIntent.OBJECTION_ERP.value: "draft_response",
            ReplyIntent.SEND_INFORMATION.value: "draft_response",
            ReplyIntent.OUT_OF_OFFICE.value: "reschedule",
            ReplyIntent.NOT_INTERESTED.value: "suppress",
        }.get(state.get("intent", ""), "finalize")

    graph = StateGraph(ReplyGraphState)
    graph.add_node("classify", classify_node)
    graph.add_node("book_call", book_call_node)
    graph.add_node("draft_response", draft_response_node)
    graph.add_node("reschedule", reschedule_node)
    graph.add_node("suppress", suppress_node)
    graph.add_node("finalize", finalize_node)

    graph.add_edge(START, "classify")
    graph.add_conditional_edges(
        "classify",
        _route,
        {
            "book_call": "book_call",
            "draft_response": "draft_response",
            "reschedule": "reschedule",
            "suppress": "suppress",
            "finalize": "finalize",
        },
    )
    for node in ("book_call", "draft_response", "reschedule", "suppress"):
        graph.add_edge(node, "finalize")
    graph.add_edge("finalize", END)
    return graph.compile()


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #

_LEAD_CONTEXT_SQL = """
SELECT p.id, p.name, p.domain, p.vertical, p.city, p.state_province, p.country,
       p.revenue_estimate_usd, p.detected_erp, p.quote_portal_type, p.audit_image_url,
       COALESCE(latest.qlv_score, 0) AS qlv_score,
       latest.rationale AS score_rationale,
       (c.first_name || ' ' || c.last_name) AS contact_name
  FROM prospects p
  LEFT JOIN LATERAL (
      SELECT qlv_score, rationale FROM scores s
       WHERE s.prospect_id = p.id ORDER BY scored_at DESC LIMIT 1
  ) latest ON TRUE
  LEFT JOIN LATERAL (
      SELECT first_name, last_name FROM contacts
       WHERE prospect_id = p.id ORDER BY created_at LIMIT 1
  ) c ON TRUE
 WHERE p.id = $1
"""

_RESOLVE_PROSPECT_SQL = """
WITH by_email AS (
    SELECT id FROM prospects WHERE lower(best_email) = lower($1) LIMIT 1
),
by_domain AS (
    SELECT p.id FROM prospects p
     WHERE p.domain = $2
       AND NOT EXISTS (SELECT 1 FROM by_email)
     ORDER BY p.created_at LIMIT 1
)
SELECT id FROM by_email
UNION ALL
SELECT id FROM by_domain
LIMIT 1
"""


class ReplyAgent:
    """Registers inbound replies, runs the graph and returns decisions."""

    def __init__(
        self,
        db: Database,
        outbox: OutboxStore,
        *,
        classifier: ReplyClassifier | None = None,
        drafter: DraftWriter | None = None,
        calendar: CalendarSync | None = None,
        settings: ReplyAgentSettings | None = None,
    ) -> None:
        self._db = db
        self._outbox = outbox
        self._classifier = classifier or ReplyClassifier()
        self._drafter = drafter or DraftWriter()
        self._calendar = calendar or CalendarSync()
        self._settings = settings or get_settings().reply_agent
        self._graph = build_reply_graph(
            db=db,
            outbox=outbox,
            classifier=self._classifier,
            drafter=self._drafter,
            calendar=self._calendar,
            settings=self._settings,
        )

    # ------------------------------------------------------------- public API
    async def register_inbound(
        self,
        *,
        from_email: str,
        subject: str | None,
        body: str,
        message_id: str | None = None,
        prospect_id: str | None = None,
        received_at: datetime | None = None,
    ) -> str:
        """Persist one inbound reply (hygiene-cleaned) and return its id."""
        cleaned = strip_quoted_text(body)
        if not cleaned:
            raise ReplyAgentError("reply body is empty after stripping quoted text")
        resolved = prospect_id or await self._resolve_prospect(from_email)
        row = await self._db.fetchrow(
            """
            INSERT INTO inbound_replies (prospect_id, message_id, from_email, subject, body, received_at)
            VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
            RETURNING id
            """,
            uuid_mod.UUID(resolved) if resolved else None,
            message_id,
            from_email,
            subject,
            cleaned,
            received_at,
        )
        log.info(
            "inbound_reply_registered",
            reply_id=str(row["id"]),
            from_email=from_email,
            prospect_id=resolved,
        )
        return str(row["id"])

    async def process_reply(self, reply_id: str) -> AgentDecision:
        """Run the full agent loop for one registered reply."""
        row = await self._db.fetchrow(
            "SELECT id, prospect_id, from_email, subject, body FROM inbound_replies WHERE id = $1",
            uuid_mod.UUID(reply_id),
        )
        if row is None:
            raise ReplyAgentError("reply not found", context={"reply_id": reply_id})

        lead_ctx = await self._lead_context(row["prospect_id"])
        if lead_ctx is None:
            domain = str(row["from_email"]).rsplit("@", 1)[-1].lower()
            lead_ctx = {"name": domain, "domain": domain}

        final_state: dict[str, Any] = await self._graph.ainvoke(
            {
                "reply_id": str(row["id"]),
                "prospect_id": str(row["prospect_id"]) if row["prospect_id"] else None,
                "from_email": str(row["from_email"]),
                "subject": str(row["subject"] or ""),
                "body": str(row["body"]),
                "lead_ctx": lead_ctx,
            }
        )
        return AgentDecision(
            reply_id=str(row["id"]),
            prospect_id=str(row["prospect_id"]) if row["prospect_id"] else None,
            intent=ReplyIntent(final_state.get("intent", ReplyIntent.UNKNOWN.value)),
            confidence=float(final_state.get("confidence", 0.0)),
            rationale=str(final_state.get("rationale", "")),
            actions=[AgentActionType(a) for a in final_state.get("actions", [])],
            draft_subject=final_state.get("draft_subject"),
            draft_body=final_state.get("draft_body"),
            calendar_event_id=final_state.get("calendar_event_id"),
            calendar_event_link=final_state.get("calendar_event_link"),
            rescheduled_to=final_state.get("rescheduled_to"),
            review_required=bool(final_state.get("draft_body")),
        )

    async def process_pending(self, *, limit: int | None = None) -> list[AgentDecision]:
        """Drain unprocessed replies oldest-first (worker/CLI entrypoint)."""
        rows = await self._db.fetch(
            """
            SELECT id FROM inbound_replies
             WHERE processed_at IS NULL
             ORDER BY received_at
             LIMIT $1
            """,
            limit or self._settings.process_pending_limit,
        )
        decisions: list[AgentDecision] = []
        for row in rows:
            try:
                decisions.append(await self.process_reply(str(row["id"])))
            except Exception as exc:  # noqa: BLE001 - batch must survive bad replies
                log.exception("reply_processing_failed", reply_id=str(row["id"]), error=str(exc))
        return decisions

    # -------------------------------------------------------------- internals
    async def _resolve_prospect(self, from_email: str) -> str | None:
        domain = from_email.rsplit("@", 1)[-1].lower()
        row = await self._db.fetchrow(_RESOLVE_PROSPECT_SQL, from_email, domain)
        return str(row["id"]) if row else None

    async def _lead_context(self, prospect_id: str | None) -> dict[str, Any] | None:
        if not prospect_id:
            return None
        row = await self._db.fetchrow(_LEAD_CONTEXT_SQL, uuid_mod.UUID(prospect_id))
        if row is None:
            return None
        return {
            "id": str(row["id"]),
            "name": row["name"],
            "domain": row["domain"],
            "vertical": row["vertical"],
            "city": row["city"],
            "state_province": row["state_province"],
            "country": row["country"],
            "revenue_estimate_usd": row["revenue_estimate_usd"],
            "detected_erp": row["detected_erp"],
            "quote_portal_type": row["quote_portal_type"],
            "audit_image_url": row["audit_image_url"],
            "qlv_score": row["qlv_score"],
            "score_rationale": row["score_rationale"],
            "contact_name": (row["contact_name"] or "").strip() or None,
        }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


async def _run(args: list[str]) -> int:
    from vertebra.logging_conf import configure_logging

    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    db = Database(settings.database)
    await db.connect()
    outbox = OutboxStore(db)
    agent = ReplyAgent(db, outbox)
    try:
        if args.reply_id:
            decision = await agent.process_reply(args.reply_id)
            print(json.dumps(decision.model_dump(mode="json"), indent=2, default=str))
        else:
            decisions = await agent.process_pending(limit=args.limit)
            print(json.dumps([d.model_dump(mode="json") for d in decisions], indent=2, default=str))
    finally:
        await db.close()
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    import argparse
    import asyncio
    import sys

    parser = argparse.ArgumentParser(description="Module 9 — closed-loop reply agent")
    parser.add_argument("--reply-id", help="Process one registered reply")
    parser.add_argument("--process-pending", action="store_true", help="Drain unprocessed replies")
    parser.add_argument("--limit", type=int, default=None, help="Batch size for --process-pending")
    sys.exit(asyncio.run(_run(parser.parse_args())))
