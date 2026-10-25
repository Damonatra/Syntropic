import json

from security.ast_veto import tenant_context
from syntropic.core.matching.catalog import QdrantHybridCatalog
from syntropic.core.schemas import CanonicalSKU
from syntropic.core.engine import _extract_payload, build_syntropic_engine


def test_extraction_preserves_all_labeled_line_items():
    extracted, confidence, errors = _extract_payload(
        "Part Number: VALVE-SS-050\nQuantity: 10\n"
        "Part Number: PIPE-SS-100\nQuantity: 3"
    )

    # Graded confidence: both items are missing a unit of measure (-0.06).
    assert confidence == 0.94
    assert errors == []
    assert [
        item["part_number"] for item in extracted["line_items"]
    ] == ["VALVE-SS-050", "PIPE-SS-100"]
    assert [
        item["extraction_confidence"] for item in extracted["line_items"]
    ] == [0.94, 0.94]


def test_extraction_and_normalization_canonicalize_uom_aliases():
    result = build_syntropic_engine().invoke(
        {
            "raw_input": (
                "Part Number: PIPE-SS-100\nQuantity: 3 feet\n"
                "Part Number: VALVE-SS-050\nQuantity: 10 pcs"
            ),
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [],
        }
    )

    assert result["extracted_data"]["line_items"] == [
        {
            "part_number": "PIPE-SS-100",
            "quantity": 3,
            "unit_of_measure": "FT",
            "extraction_confidence": 1.0,
        },
        {
            "part_number": "VALVE-SS-050",
            "quantity": 10,
            "unit_of_measure": "EA",
            "extraction_confidence": 1.0,
        },
    ]


def test_unsupported_uom_is_routed_to_human_review():
    result = build_syntropic_engine().invoke(
        {
            "raw_input": "Part Number: PIPE-SS-100\nQuantity: 3 furlongs",
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [],
        }
    )

    assert result["validation_errors"]
    assert "unsupported unit 'furlongs'" in result["validation_errors"][-1]
    assert any(
        entry.startswith("Flagged for Human Review:")
        for entry in result["execution_log"]
    )


def test_workflow_matches_every_extracted_line_item():
    result = build_syntropic_engine().invoke(
        {
            "raw_input": (
                "Part Number: VALVE-SS-050\nQuantity: 10\n"
                "Part Number: PIPE-SS-100\nQuantity: 3"
            ),
            "extracted_data": {},
            "confidence_score": 0.0,
            "validation_errors": [],
            "retry_count": 0,
            "execution_log": [],
        }
    )

    assert [
        match["catalog_item"]["part_number"]
        for match in result["matched_catalog_items"]
    ] == ["VALVE-SS-050", "PIPE-SS-100"]


def test_catalog_matches_expected_sku():
    catalog = QdrantHybridCatalog(location=":memory:")
    catalog.index_catalog_items(
        [
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
        ],
        tenant_id="tenant-catalog",
    )

    query = CanonicalSKU(
        part_number="VLV-SS-050",
        description="half in stnls steel ball valve",
        quantity=10,
        unit_of_measure="EA",
        source_row_index=1,
        extraction_confidence=0.92,
    )

    results = catalog.match_sku(query, top_k=2, tenant_id="tenant-catalog")

    assert results[0]["catalog_item"]["sku_id"] == "CAT-001"
    assert results[0]["catalog_item"]["part_number"] == "VALVE-SS-050"
    assert results[0]["rrf_score"] >= 0.95


def test_incremental_indexing_never_overwrites_earlier_skus():
    """Regression: point ids must derive from tenant+SKU identity.

    Positional ids (idx+1) meant a second index_catalog_items call silently
    overwrote the first batch's points — incremental catalog syncs lost data.
    """
    catalog = QdrantHybridCatalog(location=":memory:")
    first = [
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
            "description": "1/2 inch Brass Gate Valve, Heavy Duty Industrial",
            "unit_price": 18.50,
            "category": "Valves",
        },
    ]
    second = [
        {
            "sku_id": "CAT-003",
            "part_number": "PIPE-SS-100",
            "description": "1 inch Seamless Stainless Steel Pipe 316L Schedule 40",
            "unit_price": 110.00,
            "category": "Pipes",
        },
    ]
    catalog.index_catalog_items(first, tenant_id="tenant-catalog")
    catalog.index_catalog_items(second, tenant_id="tenant-catalog")

    for item in first + second:
        query = CanonicalSKU(
            part_number=item["part_number"],
            description=item["description"],
            quantity=1,
            unit_of_measure="EA",
            source_row_index=0,
            extraction_confidence=0.9,
        )
        results = catalog.match_sku(query, top_k=3, tenant_id="tenant-catalog")
        top_parts = [r["catalog_item"]["part_number"] for r in results]
        assert item["part_number"] in top_parts, (
            f"{item['part_number']} lost after incremental indexing; "
            f"top = {top_parts}"
        )


def test_reindexing_same_sku_is_idempotent():
    """Re-indexing a SKU must upsert in place, not duplicate or shift points."""
    catalog = QdrantHybridCatalog(location=":memory:")
    item = {
        "sku_id": "CAT-001",
        "part_number": "VALVE-SS-050",
        "description": "1/2 inch 316 Stainless Steel Ball Valve, Female NPT Thread",
        "unit_price": 42.00,
        "category": "Valves",
    }
    catalog.index_catalog_items([item], tenant_id="tenant-catalog")
    catalog.index_catalog_items([dict(item, unit_price=45.00)], tenant_id="tenant-catalog")

    query = CanonicalSKU(
        part_number="VLV-SS-050",
        description="half in stnls steel ball valve",
        quantity=1,
        unit_of_measure="EA",
        source_row_index=0,
        extraction_confidence=0.9,
    )
    results = catalog.match_sku(query, top_k=3, tenant_id="tenant-catalog")
    assert len(results) >= 1
    matches = [r for r in results if r["catalog_item"]["sku_id"] == "CAT-001"]
    assert len(matches) == 1, "re-indexed SKU must appear exactly once"
    assert matches[0]["catalog_item"]["unit_price"] == 45.00
