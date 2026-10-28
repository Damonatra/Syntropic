"""Firmographic similarity matching on Qdrant.

Lookalike expansion is how Vertebra stretches one confirmed win into a
territory plan: embed each prospect's firmographics into a deterministic
64-dimensional feature space, store it in Qdrant with payload indexes, then
nearest-neighbour search surfaces the distributors that look like the
accounts already converting.

Embeddings are *deterministic feature hashes* (vertical one-hots, log-scaled
size bands, hashed ERP/portal/city features) rather than text embeddings —
they are stable across runs, cheap, and fully auditable, which matters when
a rep asks "why is this account a lookalike?".
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Any

from vertebra.config.settings import QdrantSettings, get_settings
from vertebra.logging_conf import get_logger
from vertebra.models.domain import Vertical

log = get_logger("vector.similarity")


# --------------------------------------------------------------------------- #
# Deterministic embedding
# --------------------------------------------------------------------------- #

_DIMS = 64


def _slot(feature: str, dims: int = _DIMS) -> int:
    """Stable hash slot for a feature string."""
    return int.from_bytes(hashlib.blake2b(feature.encode(), digest_size=8).digest(), "big") % dims


def _log_band(value: float | None, floor: float, ceil: float) -> float | None:
    """Map a positive scalar onto 0..1 on a log scale within known bounds."""
    if value is None or value <= 0:
        return None
    clamped = min(max(float(value), floor), ceil)
    return (math.log10(clamped) - math.log10(floor)) / (math.log10(ceil) - math.log10(floor))


def firmographic_vector(
    *,
    vertical: str | None,
    region: str | None,
    revenue_estimate_usd: int | None,
    employee_count: int | None,
    detected_erp: str | None,
    legacy_portal: str | None = None,
    city: str | None = None,
    state_province: str | None = None,
    dims: int = _DIMS,
) -> list[float]:
    """Build the deterministic firmographic embedding.

    Layout: [0..dims) sparse feature slots; verticals/regions occupy reserved
    one-hot lanes, the rest of the space carries hashed ERP, portal and geo
    features plus continuous log-banded size scalars. Norm = L2.
    """
    vector = [0.0] * dims

    # Reserved lanes: 4 verticals + 2 regions + 2 size scalars.
    vertical_lanes = {v.value: i for i, v in enumerate(Vertical)}
    if vertical and vertical.lower() in vertical_lanes:
        vector[vertical_lanes[vertical.lower()]] = 1.0
    if region == "ca":
        vector[4] = 1.0
    elif region == "us":
        vector[5] = 1.0

    revenue_band = _log_band(revenue_estimate_usd, 1e6, 1e9)
    if revenue_band is not None:
        vector[6] = revenue_band
    headcount_band = _log_band(employee_count, 5, 2000)
    if headcount_band is not None:
        vector[7] = headcount_band

    def add_hashed(feature: str, weight: float, lanes: range) -> None:
        slot = lanes.start + _slot(feature, len(lanes))
        vector[slot] = max(vector[slot], weight)

    # ERP family: heavier weight for stronger signal; hash into lanes 8..27.
    if detected_erp:
        add_hashed(f"erp:{detected_erp.lower()}", 1.0, range(8, 28))
    if legacy_portal:
        add_hashed(f"portal:{legacy_portal.lower()}", 0.8, range(28, 40))
    if state_province:
        add_hashed(f"state:{state_province.lower()}", 0.5, range(40, 52))
    if city:
        add_hashed(f"city:{city.lower()}", 0.35, range(52, 64))

    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [round(v / norm, 6) for v in vector]


# --------------------------------------------------------------------------- #
# Qdrant index
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class SimilarProspect:
    """One nearest-neighbour hit."""

    prospect_id: str
    score: float
    company_name: str | None = None
    vertical: str | None = None


class FirmographicIndex:
    """Qdrant collection lifecycle + kNN search for lookalike expansion."""

    def __init__(self, settings: QdrantSettings | None = None) -> None:
        self._settings = settings or get_settings().qdrant
        self._client: Any | None = None

    def _qdrant(self):
        if self._client is None:
            from qdrant_client import AsyncQdrantClient  # lazy heavy import

            self._client = AsyncQdrantClient(
                url=self._settings.url,
                api_key=self._settings.api_key.get_secret_value() if self._settings.api_key else None,
                prefer_grpc=self._settings.prefer_grpc,
                timeout=self._settings.timeout_sec,
            )
        return self._client

    # ------------------------------------------------------------ collection
    async def ensure_collection(self) -> None:
        """Create the collection + payload indexes idempotently."""
        client = self._qdrant()
        from qdrant_client import models

        if not await client.collection_exists(self._settings.collection):
            await client.create_collection(
                collection_name=self._settings.collection,
                vectors_config=models.VectorParams(
                    size=self._settings.vector_size,
                    distance=models.Distance.COSINE,
                ),
            )
            log.info("qdrant_collection_created", collection=self._settings.collection)
        for field_name, field_type in (
            ("vertical", models.PayloadSchemaType.KEYWORD),
            ("region", models.PayloadSchemaType.KEYWORD),
            ("company_name", models.PayloadSchemaType.TEXT),
        ):
            try:
                await client.create_payload_index(
                    collection_name=self._settings.collection,
                    field_name=field_name,
                    field_schema=field_type,
                )
            except Exception as exc:  # noqa: BLE001 - index may already exist
                log.debug("qdrant_index_skip", field=field_name, error=str(exc))

    # ---------------------------------------------------------------- upsert
    async def upsert_prospect(
        self,
        prospect_id: str,
        vector: list[float],
        *,
        company_name: str,
        vertical: str | None,
        region: str | None,
        qlv_score: int | None = None,
    ) -> None:
        client = self._qdrant()
        from qdrant_client import models

        await client.upsert(
            collection_name=self._settings.collection,
            points=[
                models.PointStruct(
                    id=str(prospect_id),
                    vector=vector,
                    payload={
                        "company_name": company_name,
                        "vertical": vertical,
                        "region": region,
                        "qlv_score": qlv_score,
                    },
                )
            ],
        )

    # ----------------------------------------------------------------- search
    async def search_similar(
        self,
        vector: list[float],
        *,
        top_k: int = 10,
        vertical: str | None = None,
        region: str | None = None,
        min_qlv: int | None = None,
    ) -> list[SimilarProspect]:
        """Nearest neighbours with optional payload filters."""
        client = self._qdrant()
        from qdrant_client import models

        must: list[models.FieldCondition] = []
        if vertical:
            must.append(models.FieldCondition(key="vertical", match=models.MatchValue(value=vertical)))
        if region:
            must.append(models.FieldCondition(key="region", match=models.MatchValue(value=region)))
        if min_qlv is not None:
            must.append(
                models.FieldCondition(key="qlv_score", match=models.MatchRange(gte=min_qlv))
            )

        hits = await client.search(
            collection_name=self._settings.collection,
            query_vector=vector,
            query_filter=models.Filter(must=must) if must else None,
            limit=top_k,
            with_payload=True,
        )
        return [
            SimilarProspect(
                prospect_id=str(hit.id),
                score=hit.score,
                company_name=(hit.payload or {}).get("company_name"),
                vertical=(hit.payload or {}).get("vertical"),
            )
            for hit in hits
        ]

    async def similar_to_prospect(
        self,
        vector: list[float],
        *,
        exclude_prospect_id: str,
        top_k: int = 10,
    ) -> list[SimilarProspect]:
        """Lookalikes for one prospect, excluding itself."""
        neighbours = await self.search_similar(vector, top_k=top_k + 1)
        return [n for n in neighbours if n.prospect_id != exclude_prospect_id][:top_k]

    # ------------------------------------------------------------------ patch
    async def patch_payload(self, prospect_id: str, payload: dict[str, Any]) -> None:
        """Merge payload fields onto an existing prospect point (Module 5).

        Best-effort by design: a Qdrant outage must never fail the enriching
        pipeline, so failures are logged and swallowed after a single attempt.
        """
        try:
            await self._qdrant().set_payload(
                collection_name=self._settings.collection,
                payload=payload,
                points=[prospect_id],
                wait=True,
            )
            log.info("qdrant_payload_patched", prospect_id=prospect_id, fields=sorted(payload))
        except Exception as exc:  # noqa: BLE001 - vector metadata is non-critical
            log.warning("qdrant_payload_patch_failed", prospect_id=prospect_id, error=str(exc))
