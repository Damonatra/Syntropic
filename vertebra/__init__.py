"""Vertebra — the Syntropic autonomous lead & intelligence engine.

A 1-of-1 B2B enterprise lead generation, AI scoring and omnichannel
dispatch engine targeting US & Canada industrial distributors
($10M–$150M revenue) across PVF, Electrical, HVAC and Fluid Power.

Package layout
--------------
- ``vertebra.config``     Pydantic v2 settings loaded from environment / .env
- ``vertebra.models``     Shared Pydantic v2 domain models
- ``vertebra.db``         asyncpg (Neon Postgres) pool + transactional outbox
- ``vertebra.ingestion``  Directory scraping + firmographic filtering
- ``vertebra.enrichment`` Email permutations, SMTP verification, CASL policy
- ``vertebra.ai``         Claude 3.5 Sonnet scoring + LangGraph pipeline
- ``vertebra.vector``     Qdrant firmographic similarity matching
- ``vertebra.dispatch``   Dual-channel dispatch router (email / high-touch)
- ``vertebra.workers``    asyncio background workers and scheduling
- ``vertebra.api``        FastAPI application
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "1.0.0"
