"""Enrichment package: email permutations, SMTP verification and CASL policy."""

from vertebra.enrichment.casl import (
    build_casl_footer,
    build_email_headers,
    evaluate_casl_scope,
    unsubscribe_url,
)
from vertebra.enrichment.engine import EnrichmentEngine
from vertebra.enrichment.permutations import EmailPermutator, syntax_hygiene
from vertebra.enrichment.smtp_verifier import SMTPVerifier

__all__ = [
    "EmailPermutator",
    "EnrichmentEngine",
    "SMTPVerifier",
    "build_casl_footer",
    "build_email_headers",
    "evaluate_casl_scope",
    "syntax_hygiene",
    "unsubscribe_url",
]
