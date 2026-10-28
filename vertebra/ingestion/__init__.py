"""Ingestion package: industrial directory scraping and firmographic filtering."""

from vertebra.ingestion.normalizer import (
    classify_vertical,
    corridor_check,
    detect_region,
    estimate_revenue,
    is_canadian_domain,
    registrable_domain,
)
from vertebra.ingestion.scraper import DirectoryScraper, Fetcher, SourceRegistry

__all__ = [
    "DirectoryScraper",
    "Fetcher",
    "SourceRegistry",
    "classify_vertical",
    "corridor_check",
    "detect_region",
    "estimate_revenue",
    "is_canadian_domain",
    "registrable_domain",
]
