import json

from syntropic.core.matching.catalog import QdrantHybridCatalog
from syntropic.core.schemas import CanonicalSKU


def test_catalog_matches_expected_sku():
    catalog = QdrantHybridCatalog(location=":memory:")
    catalog.index_catalog_items([
        {
            "sku_id": "CAT-001",
            "part_number": "VALVE-SS-050",
            "description": "1/2 inch 316 Stainless Steel Ball Valve, Female NPT Thread",
            "unit_price": 42.00,
            "category": "Valves",
        },
        {
            "sku_id": "CAT-002",
            "part_number": "VALVE-BR-050",
            "description": "1/2 inch Brass Gate Valve, Heavy Duty Duty Industrial",
            "unit_price": 18.50,
            "category": "Valves",
        },
        {
            "sku_id": "CAT-003",
            "part_number": "PIPE-SS-100",
            "description": "1 inch Seamless Stainless Steel Pipe 316L Schedule 40",
            "unit_price": 110.00,
            "category": "Pipes",
        },
    ])

    query = CanonicalSKU(
        part_number="VLV-SS-050",
        description="half in stnls steel ball valve",
        quantity=10,
        unit_of_measure="EA",
        source_row_index=1,
        extraction_confidence=0.92,
    )

    results = catalog.match_sku(query, top_k=2)

    assert results[0]["catalog_item"]["sku_id"] == "CAT-001"
    assert results[0]["catalog_item"]["part_number"] == "VALVE-SS-050"
    assert results[0]["rrf_score"] >= 0.95
    assert len(results) == 2
