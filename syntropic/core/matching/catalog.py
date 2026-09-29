# syntropic/matching/catalog.py

from typing import List, Dict, Any, Optional
from qdrant_client import QdrantClient, models
from fastembed import TextEmbedding, SparseTextEmbedding
from syntropic.core.schemas import CanonicalSKU


class QdrantHybridCatalog:
    """
    Syntropic Catalog Matching Engine using Qdrant Hybrid Search.
    Combines BM25 sparse keyword vectors with dense semantic embeddings
    fused via Reciprocal Rank Fusion (RRF).
    """

    COLLECTION_NAME = "syntropic_master_catalog"

    def __init__(self, location: str = ":memory:", api_key: Optional[str] = None):
        """
        Initializes Qdrant client and FastEmbed models.
        Default location uses local in-memory storage for development.
        Pass a URL (e.g. 'http://localhost:6333') for production.
        """
        self.client = QdrantClient(location=location, api_key=api_key)
        
        # Native, lightweight FastEmbed models for dense and sparse vectors
        print("[Catalog Engine] Loading embedding models...")
        self.dense_model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
        self.sparse_model = SparseTextEmbedding(model_name="Qdrant/bm25")
        
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
                        distance=models.Distance.COSINE
                    )
                },
                sparse_vectors_config={
                    "sparse": models.SparseVectorParams(
                        modifier=models.Modifier.IDF
                    )
                }
            )

    def index_catalog_items(self, items: List[Dict[str, Any]]) -> None:
        """
        Indexes a list of master catalog products into Qdrant.
        Expects items with keys: 'sku_id', 'part_number', 'description', 'unit_price', 'category'.
        """
        points = []
        for idx, item in enumerate(items):
            # Combine part number and description into a single searchable text blob
            text_payload = f"{item['part_number']} {item['description']}"

            # Generate dense and sparse vector embeddings
            dense_vector = list(self.dense_model.embed([text_payload]))[0].tolist()
            sparse_vector_raw = list(self.sparse_model.embed([text_payload]))[0]

            sparse_vector = models.SparseVector(
                indices=sparse_vector_raw.indices.tolist(),
                values=sparse_vector_raw.values.tolist()
            )

            points.append(
                models.PointStruct(
                    id=idx + 1,
                    vector={
                        "dense": dense_vector,
                        "sparse": sparse_vector
                    },
                    payload=item
                )
            )

        self.client.upsert(collection_name=self.COLLECTION_NAME, points=points)
        print(f"[Catalog Engine] Successfully indexed {len(items)} catalog items into Qdrant.")

    def match_sku(self, extracted_sku: CanonicalSKU, top_k: int = 3) -> List[Dict[str, Any]]:
        """
        Performs hybrid search for an extracted CanonicalSKU payload.
        Fuses BM25 sparse keyword results with dense semantic results using RRF.
        """
        search_query = f"{extracted_sku.part_number} {extracted_sku.description}"

        # 1. Embed query into dense and sparse representations
        dense_query = list(self.dense_model.embed([search_query]))[0].tolist()
        sparse_query_raw = list(self.sparse_model.embed([search_query]))[0]
        
        sparse_query = models.SparseVector(
            indices=sparse_query_raw.indices.tolist(),
            values=sparse_query_raw.values.tolist()
        )

        # 2. Execute Hybrid Prefetch + RRF Fusion Query
        results = self.client.query_points(
            collection_name=self.COLLECTION_NAME,
            prefetch=[
                models.Prefetch(
                    query=dense_query,
                    using="dense",
                    limit=20
                ),
                models.Prefetch(
                    query=sparse_query,
                    using="sparse",
                    limit=20
                )
            ],
            # Fuse dense and sparse search rankings using Reciprocal Rank Fusion (RRF)
            query=models.FusionQuery(fusion=models.Fusion.RRF),
            limit=top_k
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
            "category": "Valves"
        },
        {
            "sku_id": "CAT-002",
            "part_number": "VALVE-BR-050",
            "description": "1/2 inch Brass Gate Valve, Heavy Duty Duty Industrial",
            "unit_price": 18.50,
            "category": "Valves"
        },
        {
            "sku_id": "CAT-003",
            "part_number": "PIPE-SS-100",
            "description": "1 inch Seamless Stainless Steel Pipe 316L Schedule 40",
            "unit_price": 110.00,
            "category": "Pipes"
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


if __name__ == "__main__":
    main()