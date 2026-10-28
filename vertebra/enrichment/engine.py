"""Enrichment engine: permutator + SMTP verifier + CASL evaluation in one pass.

``EnrichmentEngine.enrich`` takes a :class:`~vertebra.models.domain.Prospect`
with contacts attached and returns the prospect carrying:

1. a CASL jurisdiction verdict (drives footer/header policy downstream),
2. hygiene-checked deterministic email permutations for every contact,
3. the best verified mailbox promoted to ``prospect.best_email``.
"""

from __future__ import annotations

import asyncio

from vertebra.ingestion.normalizer import detect_region
from vertebra.enrichment.casl import evaluate_casl_scope
from vertebra.enrichment.permutations import EmailPermutator
from vertebra.enrichment.smtp_verifier import SMTPVerifier
from vertebra.logging_conf import get_logger
from vertebra.models.domain import CompanyRecord, Prospect, SmtpVerification
from vertebra.models.errors import EnrichmentError

log = get_logger("enrichment.engine")


class EnrichmentEngine:
    """Coordinates contact-level enrichment for prospects."""

    def __init__(
        self,
        permutator: EmailPermutator | None = None,
        verifier: SMTPVerifier | None = None,
        *,
        verify_live: bool = True,
        max_concurrent_probes: int = 4,
    ) -> None:
        self._permutator = permutator or EmailPermutator()
        self._verifier = verifier or SMTPVerifier()
        self._verify_live = verify_live
        self._probe_semaphore = asyncio.Semaphore(max_concurrent_probes)

    async def enrich(self, company: CompanyRecord, contacts: list | None = None) -> Prospect:
        """Enrich one company into a fully-processed prospect.

        Raises :class:`EnrichmentError` when the company has no usable domain.
        """
        if not company.domain:
            raise EnrichmentError(
                "cannot enrich without a registrable domain",
                context={"company": company.name, "source": company.source},
            )

        casl_scope, casl_reason = evaluate_casl_scope(
            domain=company.domain,
            region=company.region
            or detect_region(state_province=company.state_province, country=company.country, domain=company.domain),
            state_province=company.state_province,
            country=company.country,
        )

        prospect = Prospect(
            company=company,
            contacts=contacts or [],
            casl_scope=casl_scope,
            casl_reason=casl_reason,
        )
        if not prospect.contacts:
            return prospect

        prospect.email_candidates = self._permutator.generate_for_domain(
            prospect.contacts, company.domain, casl_scope=casl_scope
        )

        if self._verify_live:
            prospect.email_candidates = await self._verify_candidates(prospect.email_candidates)

        best = self._select_best(prospect.email_candidates)
        prospect.best_email = best.address if best else None
        log.info(
            "prospect_enriched",
            company=company.name,
            domain=company.domain,
            casl_scope=casl_scope,
            candidates=len(prospect.email_candidates),
            best_email=prospect.best_email,
        )
        return prospect

    # -------------------------------------------------------------- internals
    async def _verify_candidates(self, candidates: list) -> list:
        """Probe candidates top-down with bounded concurrency; stop at first hit."""
        results: dict[str, SmtpVerification] = {}
        found: list[SmtpVerification] = []

        async def probe(candidate) -> None:
            if found or not candidate.syntax_valid:
                return
            async with self._probe_semaphore:
                if found:  # re-check after acquiring the slot
                    return
                verification = await self._verifier.verify(candidate.address)
                results[candidate.address] = verification
                candidate.verified = verification.deliverable
                candidate.verification_method = verification.method
                candidate.smtp_code = verification.smtp_code
                candidate.verified_at = verification.checked_at
                if verification.deliverable:
                    found.append(verification)

        await asyncio.gather(*(probe(c) for c in candidates))
        return candidates

    @staticmethod
    def _select_best(candidates: list):
        """Prefer SMTP-verified, then MX-only, then first syntax-valid candidate."""
        for candidate in candidates:
            if candidate.verified:
                return candidate
        for candidate in candidates:
            if candidate.verification_method in {"mx", "catch_all_neutral"} and candidate.syntax_valid:
                return candidate
        return next((c for c in candidates if c.syntax_valid), None)
