import pytest

from syntropic.core.engine import catalog_match_node, erp_sync_node
from syntropic.core.normalization import normalize_unit_of_measure
from syntropic.core.normalizer import TradeAttributeNormalizer


def test_normalize_trade_units_to_erp_codes():
    assert TradeAttributeNormalizer.normalize_uom("pieces") == "EA"
    assert TradeAttributeNormalizer.normalize_uom("pack of 10") == "BX"
    assert TradeAttributeNormalizer.normalize_uom("feet") == "FT"
    assert TradeAttributeNormalizer.normalize_uom("meters") == "MTR"
    assert TradeAttributeNormalizer.normalize_uom("unknown") == "EA"


def test_existing_workflow_normalizer_flags_unsupported_units():
    assert normalize_unit_of_measure("M") == "MTR"
    assert normalize_unit_of_measure("LB") == "LBS"
    assert normalize_unit_of_measure("pack of 10") == "BX"
    assert normalize_unit_of_measure("furlongs") is None


def test_extract_dimensions_normalizes_fraction_decimal_and_metric_values():
    normalizer = TradeAttributeNormalizer()
    fraction_text, fraction_specs = normalizer.extract_dimensions(
        "1/2 in stainless valve"
    )
    decimal_text, decimal_specs = normalizer.extract_dimensions("0.5")
    metric_text, metric_specs = normalizer.extract_dimensions("12.7mm stainless valve")

    assert fraction_text == "0.5 IN STAINLESS VALVE"
    assert decimal_text == "0.5 IN"
    assert metric_text == "0.5 IN STAINLESS VALVE"
    assert fraction_specs["size_in"] == decimal_specs["size_in"] == 0.5
    assert metric_specs == {"size_mm": 12.7, "size_in": 0.5}


def test_catalog_match_receives_normalized_description_and_attributes():
    class Catalog:
        def match_sku(self, sku, top_k):
            assert top_k == 3
            assert sku.description == "0.5 IN STAINLESS VALVE"
            assert sku.specifications == {"size_in": "0.5"}
            return [
                {
                    "catalog_item": {"part_number": "VALVE-1"},
                    "rrf_score": 0.98,
                }
            ]

    result = catalog_match_node(
        {
            "raw_input": "",
            "extracted_data": {
                "line_items": [
                    {
                        "part_number": "VALVE-1",
                        "quantity": 1,
                        "unit_of_measure": "EA",
                        "description": "1/2 in stainless valve",
                    }
                ]
            },
        },
        Catalog(),
    )

    assert result["matched_catalog_items"][0]["extracted_item"] == {
        "part_number": "VALVE-1",
        "quantity": 1,
        "unit_of_measure": "EA",
        "description": "0.5 IN STAINLESS VALVE",
        "specifications": {"size_in": "0.5"},
    }


def test_erp_sync_node_normalizes_payload_and_requests_webhook_delivery():
    state = {
        "confidence_score": 1.0,
        "validation_errors": [],
        "extracted_data": {
            "line_items": [
                {
                    "part_number": "VALVE-1",
                    "quantity": 1,
                    "unit_of_measure": "pack",
                    "description": "1/2 in stainless valve",
                    "specifications": {"material": "316 SS"},
                }
            ]
        },
        "matched_catalog_items": [],
        "matched_catalog_item": None,
    }

    update = erp_sync_node(state)

    assert state["extracted_data"]["line_items"][0]["description"] == (
        "1/2 in stainless valve"
    )
    assert update["webhook_dispatch_requested"] is True
    assert update["extracted_data"]["line_items"] == [
        {
            "part_number": "VALVE-1",
            "quantity": 1,
            "unit_of_measure": "BX",
            "description": "0.5 IN STAINLESS VALVE",
            "specifications": {"material": "316 SS", "size_in": "0.5"},
        }
    ]
    assert update["execution_log"][0].startswith("ERP webhook queued")


def test_erp_sync_node_refuses_low_confidence_payload():
    with pytest.raises(ValueError, match="Refusing ERP push"):
        erp_sync_node(
            {
                "confidence_score": 0.5,
                "validation_errors": [],
                "extracted_data": {},
            }
        )
