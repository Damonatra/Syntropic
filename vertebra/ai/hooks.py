"""Hyper-personalised cold-email hooks.

Hook authoring is split from scoring so each concern evolves independently:
the Claude tool schema in :mod:`vertebra.ai.scorer` asks the model for hook
flavors, while this module owns the deterministic composition used by the
rubric fallback and provides the copy constraints both paths must respect.
"""

from __future__ import annotations

from vertebra.logging_conf import get_logger
from vertebra.models.domain import Hook, QLVFactor

log = get_logger("ai.hooks")

#: Hook bodies must reference *observed* pain (manual RFQ latency, unapplied
#: vendor SPAs, portal drift) — never generic cold-email filler.
_MAX_HOOK_BODY = 600


def build_rubric_hooks(company_name: str, factors: list[QLVFactor], erp: str | None) -> list[Hook]:
    """Compose grounded hooks from rubric factor evidence (fallback path)."""
    hooks: list[Hook] = []
    ranked = sorted(factors, key=lambda f: f.weight * f.points, reverse=True)

    for factor in ranked[:3]:
        if factor.key == "rfq_latency":
            hooks.append(
                Hook(
                    flavor="rfq_latency",
                    body=(
                        f"Most {factor.evidence} distributors we talk to lose 6–14 hours per week "
                        f"re-keying RFQs between fax, email threads and {erp or 'their quoting system'}. "
                        f"If a quote request sits longer than a day at {company_name}, the contractor "
                        f"has already called the next house. Worth 15 minutes to see the numbers?"
                    ),
                )
            )
        elif factor.key == "unapplied_spa":
            hooks.append(
                Hook(
                    flavor="spa_leakage",
                    body=(
                        f"Quick observation about {company_name}: {factor.evidence} — when vendor SPAs "
                        f"sit unapplied, every quote either leaks margin or prices you out. We built "
                        f"an engine that flags SPA gaps before the quote goes out the door. Open to a look?"
                    ),
                )
            )
        elif factor.key == "legacy_portal":
            hooks.append(
                Hook(
                    flavor="portal_drift",
                    body=(
                        f"{company_name} still runs quoting through {factor.evidence}. "
                        f"Teams on those portals tell us the same story: status lives in someone's inbox, "
                        f"and customers call asking where their RFQ went. There is a cleaner way to run this."
                    ),
                )
            )
        elif factor.key == "manual_quoting_share":
            hooks.append(
                Hook(
                    flavor="rfq_latency",
                    body=(
                        f"{factor.evidence} — that manual quoting load is exactly where quote leakage "
                        f"starts at distributors like {company_name}. We automate the intake-to-quote "
                        f"path without touching your ERP. Interested in the benchmark?"
                    ),
                )
            )

    if not hooks:  # vertical/size-only evidence
        hooks.append(
            Hook(
                flavor="peer_proof",
                body=(
                    f"We just helped a distributor with a profile close to {company_name} cut quote "
                    f"turnaround from two days to under three hours. Happy to share how it worked — "
                    f"no pitch deck, just the workflow."
                ),
            )
        )

    trimmed = [Hook(flavor=h.flavor, body=h.body[:_MAX_HOOK_BODY]) for h in hooks]
    log.debug("rubric_hooks_built", company=company_name, count=len(trimmed))
    return trimmed
