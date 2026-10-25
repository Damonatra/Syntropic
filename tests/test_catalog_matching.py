import json

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
