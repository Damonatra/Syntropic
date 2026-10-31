"""Hybrid Reciprocal Rank Fusion (RRF) combining dense vector similarity and lexical matching.

Implements reciprocal rank fusion (RRF) with default k=60 to merge dense embedding
proximity from Qdrant with sparse/lexical token scoring (e.g. SKU and part numbers).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ScoredEntity:
    """An entity item with individual and fused retrieval scores."""

    id: str
    rrf_score: float
    dense_rank: int | None
    lexical_rank: int | None
    payload: dict[str, Any]


def reciprocal_rank_fusion(
    dense_ranked_ids: list[str],
    lexical_ranked_ids: list[str],
    k: int = 60,
    payloads: dict[str, dict[str, Any]] | None = None,
) -> list[ScoredEntity]:
    """Combine two ranked result lists using Reciprocal Rank Fusion (RRF).

    Formula:
        RRF_Score(d) = sum( 1 / (k + rank_i(d)) )

    Args:
        dense_ranked_ids: Ordered entity IDs from dense vector similarity.
        lexical_ranked_ids: Ordered entity IDs from lexical/token matching.
        k: Smoothing constant (default 60, standard in IR literature).
        payloads: Optional map of entity ID to metadata payload dictionary.

    Returns:
        List of ScoredEntity items sorted by descending RRF score.
    """
    scores: dict[str, float] = {}
    dense_ranks: dict[str, int] = {}
    lexical_ranks: dict[str, int] = {}

    for rank, entity_id in enumerate(dense_ranked_ids, start=1):
        dense_ranks[entity_id] = rank
        scores[entity_id] = scores.get(entity_id, 0.0) + (1.0 / (k + rank))

    for rank, entity_id in enumerate(lexical_ranked_ids, start=1):
        lexical_ranks[entity_id] = rank
        scores[entity_id] = scores.get(entity_id, 0.0) + (1.0 / (k + rank))

    payload_map = payloads or {}
    results = [
        ScoredEntity(
            id=entity_id,
            rrf_score=round(score, 6),
            dense_rank=dense_ranks.get(entity_id),
            lexical_rank=lexical_ranks.get(entity_id),
            payload=payload_map.get(entity_id, {}),
        )
        for entity_id, score in scores.items()
    ]

    # Sort primarily by RRF score descending, then by entity ID for deterministic tie-breaking
    results.sort(key=lambda item: (-item.rrf_score, item.id))
    return results
