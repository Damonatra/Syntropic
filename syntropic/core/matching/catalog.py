# syntropic/matching/catalog.py

import time
from typing import List, Dict, Any, Optional
from qdrant_client import QdrantClient, models
from fastembed import TextEmbedding, SparseTextEmbedding
from security.ast_veto import TenantIsolationViolationError, enforce_tenant_isolation
from syntropic.core.config import settings
from syntropic.core.schemas import CanonicalSKU


class QdrantHybridCatalog:
    """
    Syntropic Catalog Matching Engine using Qdrant Hybrid Search.
    Combines BM25 sparse keyword vectors with dense semantic embeddings
    fused via Reciprocal Rank Fusion (RRF).
    """

    COLLECTION_NAME = "syntropic_master_catalog"
    EMBED_BATCH_SIZE = 64
    UPSERT_CHUNK_SIZE = 256

    def __init__(
        self,
        location: Optional[str] = None,
        api_key: Optional[str] = None,
    ):
        """
        Initializes Qdrant client and FastEmbed models.
        An explicit location wins; otherwise the configured QDRANT_URL is
        used and local in-memory storage is the development fallback.
        """
        resolved_location = location or (settings.QDRANT_URL or ":memory:")
        self.location = resolved_location
        self.client = QdrantClient(location=resolved_location, api_key=api_key)

        # Native, lightweight FastEmbed models for dense and sparse vectors
        print("[Catalog Engine] Loading embedding models...")
        self.dense_model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
        self.sparse_model = SparseTextEmbedding(model_name="Qdrant/bm25")

        # Per-query hybrid search latency in milliseconds (instrumentation).
        self.last_query_latency_ms: Optional[float] = None

        self._ensure_collection_exists()

    def _ensure_collection_exists(self) -> None:
        """Creates or updates the Qdrant hybrid collection with dual vector spaces."""
        collections = [c.name for c in self.client.get_collections().collections]

        if self.COLLECTION_NAME not in collections:
            print(f"[Catalog Engine] Creating hybrid collection: '{self.COLLECTION_NAME}'...")
            self.client.create_collection(
                collection_name=self.COLLECTION_NAME,
                vectors_config={
                    "dense": models.VectorParams(
                        size=384,  # bge-small-en-v1.5 output vector size
                        distance=models.Distance.COSINE,
                        # Tuned for 500k-point scale: wider graph + deeper
                        # construction for better recall at high throughput.
                        hnsw_config=models.HnswConfigDiff(
                            m=32,
                            ef_construct=256,
                        ),
                    )
                },
                sparse_vectors_config={
                    "sparse": models.SparseVectorParams(
                        modifier=models.Modifier.IDF
                    )
                },
                # INT8 scalar quantization keeps vectors in RAM for the
                # claimed 500k-SKU working set at a controlled memory cost.
                quantization_config=models.ScalarQuantization(
                    scalar=models.ScalarQuantizationConfig(
                        type=models.ScalarType.INT8,
                        quantile=0.99,
                        always_ram=True,
                    )
                ),
            )

    @enforce_tenant_isolation
    def index_catalog_items(
        self, items: List[Dict[str, Any]], *, tenant_id: Optional[str] = None
    ) -> None:
        """
        Indexes a list of master catalog products into Qdrant for a tenant.
        Expects items with keys: 'sku_id', 'part_number', 'description',
        'unit_price', 'category'. Embeddings are batched and upserts are
        flushed in durable chunks (wait=True) so large catalogs cannot lose
        tail points on interruption. Every payload is tagged with the bound
        tenant so hybrid queries can never leak across tenants.
        """
        if not tenant_id:
            raise TenantIsolationViolationError(
                "Security Veto Triggered: index_catalog_items requires a tenant_id."
            )
        if not items:
            return

        # Combine part number and description into a single searchable text blob
        text_payloads = [
            f"{item['part_number']} {item['description']}" for item in items
        ]

        # Generate dense and sparse vector embeddings in batches
        dense_vectors = [
            vector.tolist()
            for vector in self.dense_model.embed(
                text_payloads, batch_size=self.EMBED_BATCH_SIZE
            )
        ]
        sparse_vectors = list(
            self.sparse_model.embed(
                text_payloads, batch_size=self.EMBED_BATCH_SIZE
            )
        )

        points = []
        for idx, item in enumerate(items):
            sparse_vector_raw = sparse_vectors[idx]
            sparse_vector = models.SparseVector(
                indices=sparse_vector_raw.indices.tolist(),
                values=sparse_vector_raw.values.tolist()
            )
            tenant_payload = dict(item)
            tenant_payload["tenant_id"] = tenant_id
            points.append(
                models.PointStruct(
                    id=idx + 1,
                    vector={
                        "dense": dense_vectors[idx],
                        "sparse": sparse_vector
                    },
                    payload=tenant_payload
                )
            )

        # Chunked durable upserts so the tail of a large catalog is never lost.
        for chunk_start in range(0, len(points), self.UPSERT_CHUNK_SIZE):
            self.client.upsert(
                collection_name=self.COLLECTION_NAME,
                points=points[chunk_start:chunk_start + self.UPSERT_CHUNK_SIZE],
                wait=True,
            )
        print(f"[Catalog Engine] Successfully indexed {len(items)} catalog items into Qdrant.")

    @enforce_tenant_isolation
    def match_sku(
        self,
        extracted_sku: CanonicalSKU,
        top_k: int = 3,
        *,
        tenant_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Performs hybrid search for an extracted CanonicalSKU payload.
        Fuses BM25 sparse keyword results with dense semantic results using RRF
        and records per-query latency for SLA instrumentation. The query is
        hard-filtered to the bound tenant so results can never cross tenants.
        """
        if not tenant_id:
            raise TenantIsolationViolationError(
                "Security Veto Triggered: match_sku requires a tenant_id."
            )
        search_query = f"{extracted_sku.part_number} {extracted_sku.description}"

        # 1. Embed query into dense and sparse representations
        dense_query = list(self.dense_model.embed([search_query]))[0].tolist()
        sparse_query_raw = list(self.sparse_model.embed([search_query]))[0]

        sparse_query = models.SparseVector(
            indices=sparse_query_raw.indices.tolist(),
            values=sparse_query_raw.values.tolist()
        )

        # 2. Execute Hybrid Prefetch + RRF Fusion Query (latency instrumented,
        #    tenant-scoped via a mandatory payload filter).
        started = time.perf_counter()
        results = self.client.query_points(
            collection_name=self.COLLECTION_NAME,
            prefetch=[
                models.Prefetch(
                    query=dense_query,
                    using="dense",
                    limit=20,
                    filter=models.Filter(
                        must=[
                            models.FieldCondition(
                                key="tenant_id",
                                match=models.MatchValue(value=tenant_id),
                            )
                        ]
                    ),
                ),
                models.Prefetch(
                    query=sparse_query,
                    using="sparse",
                    limit=20,
                    filter=models.Filter(
                        must=[
                            models.FieldCondition(
                                key="tenant_id",
                                match=models.MatchValue(value=tenant_id),
                            )
                        ]
                    ),
                )
            ],
            query_filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="tenant_id",
                        match=models.MatchValue(value=tenant_id),
                    )
                ]
            ),
            # Fuse dense and sparse search rankings using Reciprocal Rank Fusion (RRF)
            query=models.FusionQuery(fusion=models.Fusion.RRF),
            limit=top_k
        )
        self.last_query_latency_ms = round(
            (time.perf_counter() - started) * 1000.0, 2
        )
        print(
            f"[Catalog Engine] Hybrid query latency: "
            f"{self.last_query_latency_ms:.2f} ms "
            f"({extracted_sku.part_number}, tenant={tenant_id})."
        )

        matches = []
        for point in results.points:
            matches.append({
                "catalog_item": point.payload,
                "rrf_score": round(point.score, 4),
            })

        return matches


# =====================================================================
# VERIFICATION & LOCAL EXECUTION
# =====================================================================


def _demo_catalog_items() -> List[Dict[str, Any]]:
    return [
        {
            "sku_id": "CAT-001",
            "part_number": "VALVE-SS-050",
            "description": "1/2 inch 316 Stainless Steel Ball Valve, Female NPT Thread",
            "unit_price": 42.00,
            "category": "Valves",
            "currency": "USD",
            "rebate_schedule": {
                "rebate_pct": 0.05,
                "effective_from": "2026-01-01",
                "effective_until": "2026-12-31",
                "volume_tiers": [
                    {"min_qty": 100, "rebate_pct": 0.08},
                    {"min_qty": 500, "rebate_pct": 0.12},
                ],
            },
            "cost_sheet_updated": "2026-01-15",
        },
        {
            "sku_id": "CAT-002",
            "part_number": "VALVE-BR-050",
            "description": "1/2 inch Brass Gate Valve, Heavy Duty Duty Industrial",
            "unit_price": 18.50,
            "category": "Valves",
            "currency": "USD",
            "rebate_schedule": None,
            "cost_sheet_updated": "2026-09-20",
        },
        {
            "sku_id": "CAT-003",
            "part_number": "PIPE-SS-100",
            "description": "1 inch Seamless Stainless Steel Pipe 316L Schedule 40",
            "unit_price": 110.00,
            "category": "Pipes",
            "currency": "USD",
            "rebate_schedule": {
                "effective_from": "2026-12-31",
                "effective_until": "2026-01-01",
            },
            "cost_sheet_updated": "2026-10-01",
        }
    ]


def main() -> None:
    import json

    print("--- Testing Syntropic Catalog Matching Engine (Phase 3) ---")
    catalog = QdrantHybridCatalog(location=":memory:")
    master_catalog = _demo_catalog_items()

    catalog.index_catalog_items(master_catalog)

    test_extracted_sku = CanonicalSKU(
        part_number="VLV-SS-050",
        description="half in stnls steel ball valve",
        quantity=10,
        unit_of_measure="EA",
        source_row_index=1,
        extraction_confidence=0.92
    )

    print(f"\nQuerying Catalog for Extracted SKU: '{test_extracted_sku.part_number}' ({test_extracted_sku.description})")
    matched_candidates = catalog.match_sku(test_extracted_sku, top_k=2)

    print("\n--- MATCH RESULTS (Ranked by RRF Score) ---")
    print(json.dumps(matched_candidates, indent=2))
    print(
        f"\n[Catalog Engine] Last query latency: "
        f"{catalog.last_query_latency_ms:.2f} ms"
    )


if __name__ == "__main__":
    main()
