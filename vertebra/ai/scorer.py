"""Quote Leakage Vulnerability scoring.

Primary path: Claude 3.5 Sonnet via the Anthropic async SDK with a forced
tool schema, so every score arrives as validated structured output with
grounded factor evidence and hyper-personalised hooks.

Fallback path: :class:`RubricScorer`, a transparent deterministic rubric over
the same weighted factors. It exists for Claude API outages and rate-limit
storms — degraded mode still produces defensible, evidence-backed scores and
never blocks the pipeline.

Scores are cached in-process by input fingerprint (SHA-256 of the normalised
input); the Postgres ``scores`` table adds a cross-restart unique index on
the same fingerprint.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

from vertebra.ai.hooks import build_rubric_hooks
from vertebra.config.settings import AnthropicSettings, get_settings
from vertebra.logging_conf import get_logger
from vertebra.models.domain import (
    Hook,
    QLVFactor,
    ScoreResult,
    Vertical,
)
from vertebra.models.errors import ScoringError

log = get_logger("ai.scorer")

#: Factor weights — published internally as the "leakage anatomy" and kept
#: here as the single source of truth for both scoring paths.
FACTOR_WEIGHTS: dict[str, float] = {
    "rfq_latency": 0.28,
    "legacy_portal": 0.22,
    "unapplied_spa": 0.18,
    "manual_quoting_share": 0.14,
    "vertical_fit": 0.10,
    "size_fit": 0.08,
}

_BANDS: tuple[tuple[int, str], ...] = ((85, "critical"), (65, "high"), (40, "medium"), (0, "low"))


def band_for_score(score: int) -> str:
    for threshold, band in _BANDS:
        if score >= threshold:
            return band
    return "low"


@dataclass(slots=True)
class ScoringInput:
    """Normalised prospect payload handed to both scoring paths."""

    prospect_id: str
    company_name: str
    vertical: str | None
    region: str | None
    revenue_estimate_usd: int | None
    employee_count: int | None
    detected_erp: str | None = None
    legacy_portal: str | None = None
    notes: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def fingerprint(self) -> str:
        """Stable content hash — cache key for idempotent scoring."""
        canonical = json.dumps(
            {k: v for k, v in asdict(self).items() if k != "prospect_id"},
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(canonical.encode()).hexdigest()

    def to_prompt_context(self) -> str:
        lines = [
            f"Company: {self.company_name}",
            f"Vertical: {self.vertical or 'unknown'}",
            f"Region: {self.region or 'unknown'}",
            f"Revenue estimate: {f'${self.revenue_estimate_usd:,.0f}' if self.revenue_estimate_usd else 'unknown'}",
            f"Employee count: {self.employee_count or 'unknown'}",
            f"Detected ERP: {self.detected_erp or 'none detected'}",
            f"Legacy portal signals: {self.legacy_portal or 'none'}",
        ]
        if self.notes:
            lines.append(f"Field notes: {self.notes}")
        return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Claude tool schema (forced structured output)
# --------------------------------------------------------------------------- #

_TOOL_NAME = "emit_quote_leakage_score"
_TOOL_SCHEMA: dict[str, Any] = {
    "name": _TOOL_NAME,
    "description": (
        "Score an industrial distributor's Quote Leakage Vulnerability (1-100) "
        "and author hyper-personalised cold-email hooks grounded ONLY in the "
        "provided evidence."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "qlv_score": {"type": "integer", "minimum": 1, "maximum": 100},
            "factors": {
                "type": "array",
                "minItems": 4,
                "items": {
                    "type": "object",
                    "properties": {
                        "key": {
                            "type": "string",
                            "enum": list(FACTOR_WEIGHTS.keys()),
                        },
                        "points": {"type": "number", "minimum": 0, "maximum": 100},
                        "evidence": {"type": "string", "minLength": 10},
                    },
                    "required": ["key", "points", "evidence"],
                    "additionalProperties": False,
                },
            },
            "hooks": {
                "type": "array",
                "minItems": 2,
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "properties": {
                        "flavor": {
                            "type": "string",
                            "enum": ["rfq_latency", "spa_leakage", "portal_drift", "peer_proof"],
                        },
                        "body": {"type": "string", "minLength": 40, "maxLength": 600},
                    },
                    "required": ["flavor", "body"],
                    "additionalProperties": False,
                },
            },
            "rationale": {"type": "string", "minLength": 40},
        },
        "required": ["qlv_score", "factors", "hooks", "rationale"],
        "additionalProperties": False,
    },
}

_SYSTEM_PROMPT = (
    "You are Syntropic's senior industrial-distribution analyst. You score US and Canada "
    "distributors (PVF, Electrical, HVAC, Fluid Power) on Quote Leakage Vulnerability: how "
    "much revenue the company likely loses because manual RFQ handling, legacy customer "
    "portals and unapplied vendor SPAs push quotes out late or mispriced.\n"
    "Rules:\n"
    "- Ground every factor in the evidence given; never invent ERPs, portals or numbers.\n"
    "- 1-39 = healthy quoting operation; 40-64 = visible leakage; 65-84 = structural leakage; "
    "85-100 = active bleed.\n"
    "- Hooks must reference manual RFQ latency or unapplied vendor SPAs concretely, 40-80 "
    "words, no exclamation marks, no 'I hope this finds you well', no generic flattery.\n"
    "- Weight factors using these anchors: rfq_latency 0.28, legacy_portal 0.22, "
    "unapplied_spa 0.18, manual_quoting_share 0.14, vertical_fit 0.10, size_fit 0.08.\n"
    "Return the result only through the tool."
)


class RubricScorer:
    """Deterministic, explainable rubric used as the degraded-mode scorer."""

    #: ERP signatures correlated with heavy manual quoting.
    _ERP_RISK: dict[str, int] = {
        "quickbooks": 88, "sage": 78, "odoo": 72, "syspro": 55, "eclipse": 62,
        "epicor": 58, "prophet 21": 45, "p21": 45, "infor": 50, "netsuite": 48,
        "dynamics 365": 42, "microsoft dynamics": 42, "s2k": 55, "acumatica": 46,
        "sap": 35, "oracle": 38,
    }

    def score(self, payload: ScoringInput) -> ScoreResult:
        points = self._factor_points(payload)
        factors = [
            QLVFactor(key=key, weight=FACTOR_WEIGHTS[key], points=value_points, evidence=evidence)  # type: ignore[arg-type]
            for key, (value_points, evidence) in points.items()
        ]
        total = int(round(sum(f.points * f.weight for f in factors)))
        total = max(1, min(100, total))
        hooks = build_rubric_hooks(payload.company_name, factors, payload.detected_erp)
        rationale = (
            f"Rubric score {total}/100 for {payload.company_name}: "
            + "; ".join(f"{f.key.replace('_', ' ')} {f.points:.0f}/100" for f in factors)
            + ". Degraded-mode rubric applied because the Claude API was unavailable; "
            "evidence strings cite the ingested firmographics only."
        )
        return ScoreResult(
            prospect_id=payload.prospect_id,
            company_name=payload.company_name,
            qlv_score=total,
            band=band_for_score(total),  # type: ignore[arg-type]
            factors=factors,
            hooks=hooks,
            rationale=rationale,
            model="vertebra-rubric-1.0",
            scored_at=datetime.now(tz=UTC),
            input_fingerprint=payload.fingerprint(),
        )

    def _factor_points(self, p: ScoringInput) -> dict[str, tuple[float, str]]:
        erp = (p.detected_erp or "").lower()
        portal = (p.legacy_portal or "").lower()

        erp_points = next(
            (risk for signature, risk in self._ERP_RISK.items() if signature in erp), 40
        ) if erp else 30
        portal_points = 85 if portal else (min(90, erp_points + 15) if "portal" in erp else 20)

        rfq_points = min(100, erp_points * 0.6 + portal_points * 0.4)
        if p.vertical == Vertical.HVAC:
            rfq_points += 5  # seasonal spike amplifies latency pain

        vertical_fit = {"pvf": 95, "fluid_power": 90, "hvac": 80, "electrical": 70}.get(
            p.vertical, 40
        ) if p.vertical else 40

        revenue = p.revenue_estimate_usd or 0
        size_fit = 100 if 20_000_000 <= revenue <= 100_000_000 else 70 if revenue else 35

        return {
            "rfq_latency": (
                rfq_points, f"ERP={p.detected_erp or 'unknown'}, portal signals={p.legacy_portal or 'none'}"
            ),
            "legacy_portal": (portal_points, f"legacy portal evidence: {p.legacy_portal or 'none detected'}"),
            "unapplied_spa": (
                min(95, erp_points + 20),
                f"SPA enforcement typically absent on {p.detected_erp or 'manual stacks'}",
            ),
            "manual_quoting_share": (
                erp_points, f"quoting maturity inferred from {p.detected_erp or 'absent ERP signal'}"
            ),
            "vertical_fit": (float(vertical_fit), f"vertical={p.vertical or 'unknown'} (RFQ complexity fit)"),
            "size_fit": (float(size_fit), f"revenue ${revenue:,}" if revenue else "revenue unknown"),
        }


class QuoteLeakageScorer:
    """Claude-primary scorer with rubric fallback and fingerprint caching."""

    def __init__(self, settings: AnthropicSettings | None = None) -> None:
        self._settings = settings or get_settings().anthropic
        self._client: Any | None = None
        self._cache: dict[str, ScoreResult] = {}

    # ----------------------------------------------------------------- client
    def _anthropic(self):
        if self._client is None:
            import anthropic  # lazy: keeps rubric path importable without the SDK

            self._client = anthropic.AsyncAnthropic(
                api_key=self._settings.api_key.get_secret_value(),
                max_retries=self._settings.max_retries,
                timeout=self._settings.timeout_sec,
            )
        return self._client

    # ------------------------------------------------------------------ score
    async def score(self, payload: ScoringInput) -> ScoreResult:
        fingerprint = payload.fingerprint()
        cached = self._cache.get(fingerprint)
        if cached is not None:
            log.debug("score_cache_hit", company=payload.company_name)
            return cached

        try:
            result = await self._score_with_claude(payload)
            log.info("scored_claude", company=payload.company_name, qlv=result.qlv_score, band=result.band)
        except Exception as exc:  # noqa: BLE001 - degrade to rubric, never crash the pipeline
            log.warning(
                "claude_scoring_failed_degrading_to_rubric",
                company=payload.company_name,
                error=f"{type(exc).__name__}: {exc}",
            )
            result = RubricScorer().score(payload)
        self._cache[fingerprint] = result
        return result

    async def _score_with_claude(self, payload: ScoringInput) -> ScoreResult:
        client = self._anthropic()
        response = await client.messages.create(
            model=self._settings.model,
            max_tokens=self._settings.max_tokens,
            temperature=self._settings.temperature,
            system=_SYSTEM_PROMPT,
            tools=[_TOOL_SCHEMA],
            tool_choice={"type": "tool", "name": _TOOL_NAME},
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Score this distributor for Quote Leakage Vulnerability.\n\n"
                        f"{payload.to_prompt_context()}"
                    ),
                }
            ],
        )
        for block in response.content:
            if getattr(block, "type", None) == "tool_use" and block.name == _TOOL_NAME:
                return self._parse_tool_payload(payload, block.input)
        raise ScoringError("claude returned no tool_use block", context={"model": self._settings.model})

    # ------------------------------------------------------------------- parse
    def _parse_tool_payload(self, payload: ScoringInput, data: dict[str, Any]) -> ScoreResult:
        try:
            factors = [
                QLVFactor(
                    key=f["key"],
                    weight=FACTOR_WEIGHTS.get(f["key"], 0.0),
                    points=float(f["points"]),
                    evidence=str(f["evidence"]),
                )
                for f in data["factors"]
            ]
            hooks = [Hook(flavor=h["flavor"], body=str(h["body"])) for h in data["hooks"]]
            score = int(data["qlv_score"])
            if not (1 <= score <= 100):
                raise ValueError(f"qlv_score out of range: {score}")
            return ScoreResult(
                prospect_id=payload.prospect_id,
                company_name=payload.company_name,
                qlv_score=score,
                band=band_for_score(score),  # type: ignore[arg-type]
                factors=factors,
                hooks=hooks,
                rationale=str(data["rationale"]),
                model=self._settings.model,
                input_fingerprint=payload.fingerprint(),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ScoringError(
                f"malformed Claude tool payload: {exc}", context={"payload_keys": list(data)}
            ) from exc
