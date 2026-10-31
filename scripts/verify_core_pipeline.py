#!/usr/bin/env python3
"""Automated verification script for advanced Syntropic core pipeline capabilities:
  1. Unit-of-Measure (UoM) & Trade Canonicalizer (EA/BX/FT/IN/MTR/C/M/RL)
  2. Qdrant Hybrid Reciprocal Rank Fusion (RRF)
  3. Agent 6 AST Veto Gate (tenant_id query enforcement)
  4. Victor Taelin Append-Only Cryptographic Event Log (stream.log)
  5. Microsoft Graph API Draft Injection
"""

from decimal import Decimal
import os
from pathlib import Path
import sys
import tempfile

from vertebra.db.ast_veto import SecurityVetoViolation, validate_tenant_query
from vertebra.db.event_stream import EventStreamLogger
from vertebra.dispatch.graph_draft import GraphDraftPayload, MicrosoftGraphDraftClient
from vertebra.ingestion.uom_normalizer import CanonicalUoM, canonicalize_uom
from vertebra.vector.hybrid_rrf import reciprocal_rank_fusion


def test_uom_canonicalizer() -> None:
    # 50 C (hundred) should be 5000 EA
    n1 = canonicalize_uom("C", 50, unit_price="25.00")
    assert n1.canonical_unit == CanonicalUoM.EACH
    assert n1.normalized_quantity == Decimal("5000")
    assert n1.normalized_unit_price == Decimal("0.25")

    # 10 BX with pack size 24: 10 * 24 = 240 EA, unit_price is 120 per box -> 120 / 24 = 5.00 per EA
    n2 = canonicalize_uom("BX", 10, unit_price="120.00", pack_size=24)
    assert n2.canonical_unit == CanonicalUoM.EACH
    assert n2.normalized_quantity == Decimal("240")
    assert n2.normalized_unit_price == Decimal("5.00")

    # 5 CFT (hundred feet)
    n3 = canonicalize_uom("CFT", 5)
    assert n3.canonical_unit == CanonicalUoM.FOOT
    assert n3.normalized_quantity == Decimal("500")


def test_hybrid_rrf() -> None:
    dense = ["SKU-A", "SKU-B", "SKU-C"]
    lexical = ["SKU-B", "SKU-D", "SKU-A"]

    fused = reciprocal_rank_fusion(dense, lexical, k=60)
    # SKU-B ranks high in both (2nd in dense, 1st in lexical) -> top fused score
    assert fused[0].id == "SKU-B"
    assert fused[0].dense_rank == 2
    assert fused[0].lexical_rank == 1
    assert fused[0].rrf_score > fused[1].rrf_score


def test_ast_veto_gate() -> None:
    # Should pass with valid tenant_id
    valid_sql = "SELECT id, quote_num FROM quotes WHERE tenant_id = 't_123' AND status = 'open'"
    assert validate_tenant_query(valid_sql, expected_tenant_id="t_123") is True

    # Should pass with parameter placeholder
    param_sql = "SELECT * FROM orders WHERE tenant_id = $1"
    assert validate_tenant_query(param_sql) is True

    # Should raise SecurityVetoViolation when tenant_id is missing
    leaky_sql = "SELECT * FROM quotes WHERE status = 'open'"
    vetoed = False
    try:
        validate_tenant_query(leaky_sql)
    except SecurityVetoViolation:
        vetoed = True
    assert vetoed is True

    # Should raise SecurityVetoViolation on dictionary filter without tenant_id
    dict_vetoed = False
    try:
        validate_tenant_query({"status": "open"})
    except SecurityVetoViolation:
        dict_vetoed = True
    assert dict_vetoed is True


def test_append_only_event_stream() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        log_file = Path(tmpdir) / "stream.log"
        logger = EventStreamLogger(log_file)

        logger.append("rfq.received", {"rfq_id": "rfq_001", "total_lines": 42})
        logger.append("qlv.scored", {"rfq_id": "rfq_001", "score": 88})
        logger.append("quote.dispatched", {"rfq_id": "rfq_001", "channel": "Channel A"})

        # Confirm cryptographic integrity holds
        assert logger.verify_integrity() is True

        # Tampering check: altering a line should cause verification failure
        lines = log_file.read_text(encoding="utf-8").splitlines()
        tampered_line = lines[1].replace('"score": 88', '"score": 99')
        lines[1] = tampered_line
        log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

        tampered_logger = EventStreamLogger(log_file)
        assert tampered_logger.verify_integrity() is False


def test_microsoft_graph_draft() -> None:
    client = MicrosoftGraphDraftClient()
    payload = GraphDraftPayload(
        subject="Quote Leakage Audit — Ferguson Industrial",
        recipient_email="vp.purchasing@ferguson.com",
        recipient_name="Alex Miller",
        html_body="<p>Review of unapplied SPA margin leakage.</p>",
        sender_user_principal="josias@syntropic.com",
    )
    draft_body = client.format_draft_body(payload)
    assert draft_body["subject"] == "Quote Leakage Audit — Ferguson Industrial"
    assert draft_body["isDraft"] is True
    assert draft_body["toRecipients"][0]["emailAddress"]["address"] == "vp.purchasing@ferguson.com"
    assert draft_body["toRecipients"][0]["emailAddress"]["name"] == "Alex Miller"


def main() -> None:
    print("=" * 72)
    print("VERTEBRA ADVANCED CORE PIPELINE VERIFICATION")
    print("=" * 72)

    checks = [
        ("UoM & trade canonicalization", test_uom_canonicalizer),
        ("Qdrant hybrid RRF dense + lexical", test_hybrid_rrf),
        ("Agent 6 AST veto gate tenant_id enforcement", test_ast_veto_gate),
        ("Victor Taelin append-only cryptographic stream.log", test_append_only_event_stream),
        ("Microsoft Graph API draft injection formatting", test_microsoft_graph_draft),
    ]

    passed = 0
    for name, fn in checks:
        try:
            fn()
            print(f"  PASS  {name}")
            passed += 1
        except Exception as exc:
            print(f"  FAIL  {name}: {exc}")

    print("=" * 72)
    print(f"RESULT: {passed} passed, {len(checks) - passed} failed")
    if passed == len(checks):
        print("ALL ADVANCED PIPELINE CHECKS GREEN.")
        sys.exit(0)
    sys.exit(1)


if __name__ == "__main__":
    main()
