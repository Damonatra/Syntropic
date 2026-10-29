"""The dual-channel dispatch router.

Routing rule set (Q4 policy):

- QLV >= ``policy.channel_a_min_score``  → Channel A: automated outbound from
  rotating secondary domains, CASL-compliant, pacing applied.
- QLV below the threshold → Channel B: Josias High-Touch queue (CSV + outbox
  + Google Calendar follow-up), where human craft converts better than
  automation.

The router also exposes ``build_channel_nodes`` so the LangGraph pipeline can
inject the channel terminals without a circular import.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from vertebra.config.settings import get_settings
from vertebra.db.outbox import OutboxStore
from vertebra.db.pool import Database
from vertebra.dispatch.calendar_sync import CalendarSync
from vertebra.dispatch.channel_email import EmailDispatcher
from vertebra.dispatch.high_touch import HighTouchExporter
from vertebra.enrichment.casl import build_casl_footer, build_email_headers
from vertebra.logging_conf import get_logger
from vertebra.models.domain import (
    Channel,
    DispatchDecision,
    Prospect,
    ScoreResult,
)

log = get_logger("dispatch.router")

_SUBJECT_TEMPLATES: dict[str, str] = {
    "rfq_latency": "{company}: RFQ turnaround",
    "spa_leakage": "{company}: vendor SPA gaps",
    "portal_drift": "{company}: quoting through the portal",
    "peer_proof": "a benchmark for {company}",
}

_CLOSE_CTA = (
    "If this is relevant, I will send a 3-slide teardown of where the leakage "
    "shows up in a quoting workflow like yours. If not, the unsubscribe link "
    "below is instant."
)


class DispatchRouter:
    """Decides the channel, composes the send, and executes it."""

    def __init__(
        self,
        db: Database,
        *,
        email: EmailDispatcher | None = None,
        high_touch: HighTouchExporter | None = None,
        calendar: CalendarSync | None = None,
        outbox: OutboxStore | None = None,
    ) -> None:
        settings = get_settings()
        self._policy = settings.policy
        self._db = db
        self._outbox = outbox or OutboxStore(db)
        self._email = email or EmailDispatcher()
        self._calendar = calendar or CalendarSync()
        self._high_touch = high_touch or HighTouchExporter(
            db, self._outbox, export_dir=self._policy.high_touch_export_dir, calendar=self._calendar
        )

    # ----------------------------------------------------------------- decide
    def decide(self, prospect: Prospect) -> DispatchDecision:
        """Build the routing decision for a scored prospect."""
        if prospect.score is None:
            raise ValueError(f"prospect {prospect.id} has no score; run the scorer first")
        score = prospect.score
        if score.qlv_score >= self._policy.channel_a_min_score:
            channel = Channel.AUTOMATED_EMAIL
        else:
            channel = Channel.HIGH_TOUCH

        footer = None
        if channel is Channel.AUTOMATED_EMAIL and prospect.casl_scope and prospect.best_email:
            footer = build_casl_footer(
                prospect_id=prospect.id,
                address=prospect.best_email,
                region=prospect.company.region,
            )
        decision = DispatchDecision(
            prospect_id=prospect.id,
            channel=channel,
            casl_scope=prospect.casl_scope,
            footer_template=footer,
            reasons=self._reasons(score, channel),
        )
        prospect.dispatch = decision
        return decision

    # ---------------------------------------------------------------- execute
    async def execute(self, prospect: Prospect) -> DispatchDecision:
        """Persist the routing decision and execute it on the chosen channel."""
        decision = self.decide(prospect)
        score = prospect.score
        assert score is not None

        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                if decision.channel is Channel.AUTOMATED_EMAIL:
                    await self._persist_email_dispatch(conn, prospect, decision, score)
                else:
                    await self._persist_high_touch_dispatch(conn, prospect, decision, score)

        if decision.channel is Channel.AUTOMATED_EMAIL:
            decision = await self._execute_channel_a(prospect, decision, score)
        else:
            decision = await self._execute_channel_b(prospect)
        return decision

    # ------------------------------------------------------------- channel A
    async def _execute_channel_a(
        self, prospect: Prospect, decision: DispatchDecision, score: ScoreResult
    ) -> DispatchDecision:
        if not prospect.best_email:
            decision.reasons.append("suppressed: no verified mailbox")
            await self._mark_status(decision.prospect_id, "suppressed", "no_verified_mailbox")
            return decision

        subject = self._subject(score, prospect.company.name)
        body = self._body(score)
        headers = build_email_headers(
            prospect_id=prospect.id,
            address=prospect.best_email,
            casl_scope=prospect.casl_scope,
        )
        outbound = self._email.compose(
            prospect_id=prospect.id,
            to_email=prospect.best_email,
            to_name=(
                f"{prospect.primary_contact.first_name} {prospect.primary_contact.last_name}"
                if prospect.primary_contact
                else None
            ),
            subject=subject,
            body=body,
            casl_scope=prospect.casl_scope,
            footer=decision.footer_template,
            headers=headers,
        )
        decision.subject = subject
        decision.body = body
        decision.from_domain = outbound.from_domain
        # Pacing: defer queued rows to the rotator's next clean window.
        decision.send_after = datetime.now(tz=UTC) + timedelta(seconds=5)

        try:
            message_id = await self._email.send(outbound)
            await self._mark_sent(prospect.id, from_domain=outbound.from_domain,
                                  provider=self._email.active_provider,
                                  provider_msg_id=message_id)
        except Exception as exc:  # noqa: BLE001 - dispatch failures must surface as status
            log.error("channel_a_send_failed", company=prospect.company.name, error=str(exc))
            await self._mark_status(prospect.id, "failed", str(exc)[:500])
            decision.reasons.append(f"send_failed: {exc}")
        return decision

    # ------------------------------------------------------------- channel B
    async def _execute_channel_b(self, prospect: Prospect) -> DispatchDecision:
        await self._high_touch.enqueue(prospect)
        return prospect.dispatch  # type: ignore[return-value]

    # ------------------------------------------------------------ persistence
    async def _persist_email_dispatch(
        self, conn, prospect: Prospect, decision: DispatchDecision, score: ScoreResult
    ) -> None:
        await conn.execute(
            """
            INSERT INTO dispatches (prospect_id, channel, status, casl_scope, subject,
                                    body, from_domain, footer_applied, send_after)
            VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, $8)
            """,
            prospect.id,
            decision.channel.value,
            prospect.casl_scope,
            self._subject(score, prospect.company.name),
            self._body(score),
            None,
            decision.footer_template,
            decision.send_after,
        )
        await self._outbox.enqueue(
            conn,
            aggregate_type="dispatch",
            aggregate_id=prospect.id,
            event_type="dispatch.email.queued",
            payload={"qlv_score": score.qlv_score, "casl_scope": prospect.casl_scope},
        )

    async def _persist_high_touch_dispatch(
        self, conn, prospect: Prospect, decision: DispatchDecision, score: ScoreResult
    ) -> None:
        await conn.execute(
            """
            INSERT INTO dispatches (prospect_id, channel, status, casl_scope)
            VALUES ($1, $2, 'queued', $3)
            """,
            prospect.id,
            decision.channel.value,
            prospect.casl_scope,
        )
        await self._outbox.enqueue(
            conn,
            aggregate_type="high_touch",
            aggregate_id=prospect.id,
            event_type="dispatch.high_touch.queued",
            payload={"qlv_score": score.qlv_score},
        )

    async def _mark_sent(self, prospect_id: str, *, from_domain: str, provider: str, provider_msg_id: str) -> None:
        await self._db.execute(
            """
            UPDATE dispatches
               SET status='sent', provider=$2, provider_msg_id=$3, from_domain=$4,
                   sent_at=now(), updated_at=now()
             WHERE prospect_id=$1 AND status='queued'
            """,
            prospect_id, provider, provider_msg_id, from_domain,
        )

    async def _mark_status(self, prospect_id: str, status: str, error: str | None) -> None:
        await self._db.execute(
            "UPDATE dispatches SET status=$2, error=$3, updated_at=now() WHERE prospect_id=$1 AND status='queued'",
            prospect_id, status, error,
        )

    # ------------------------------------------------------------- composition
    @staticmethod
    def _subject(score: ScoreResult, company: str) -> str:
        top = score.hooks[0] if score.hooks else None
        template = _SUBJECT_TEMPLATES.get(top.flavor if top else "", "{company}: quoting benchmark")
        return template.format(company=company)

    @staticmethod
    def _body(score: ScoreResult) -> str:
        top = score.hooks[0] if score.hooks else None
        hook = top.body if top else ""
        return f"{hook}\n\n{_CLOSE_CTA}"

    @staticmethod
    def _reasons(score: ScoreResult, channel: Channel) -> list[str]:
        threshold = get_settings().policy.channel_a_min_score
        if channel is Channel.AUTOMATED_EMAIL:
            return [f"qlv {score.qlv_score} >= {threshold}: automation wins at this score"]
        return [f"qlv {score.qlv_score} < {threshold}: high-touch craft converts better here"]


# --------------------------------------------------------------------------- #
# LangGraph channel node injection
# --------------------------------------------------------------------------- #


def build_channel_nodes() -> tuple[Any, Any]:
    """Return (channel_a_node, channel_b_node) for the LangGraph pipeline.

    The nodes expect ``state['prospect']`` to carry a score and call a
    module-level router bound to the process-wide database handle.
    """
    from vertebra.db.pool import database_from_settings

    router: DispatchRouter | None = None

    def _get_router() -> DispatchRouter:
        nonlocal router
        if router is None:
            router = DispatchRouter(database_from_settings())
        return router

    async def channel_a_node(state: dict[str, Any]) -> dict[str, Any]:
        prospect = state.get("prospect")
        if prospect is not None:
            await _get_router().execute(prospect)
        return {"prospect": prospect}

    async def channel_b_node(state: dict[str, Any]) -> dict[str, Any]:
        prospect = state.get("prospect")
        if prospect is not None:
            await _get_router()._execute_channel_b(prospect)  # noqa: SLF001 - graph boundary
        return {"prospect": prospect}

    return channel_a_node, channel_b_node
