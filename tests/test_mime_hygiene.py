"""Layer 4 Section 3 — MIME/HTML hygiene contract for Outlook rendering.

The composer's HTML must render deterministically in Outlook desktop
(Word rendering engine) and Outlook web. Live-client rendering cannot be
exercised in CI, so the verifiable proxy is a hard contract on the HTML
itself — the same pattern as the draft-only send-path contract:

* NO external resources (Outlook blocks them; webmail clips them).
* NO active content (script/iframe/object/embed — stripped or blocked).
* NO class references — the draft ships zero <style> blocks, so any
  class= attribute would silently do nothing (and Gmail clips <style>
  in long messages anyway). Alignment uses the legacy align= attribute
  the Word engine honors.
* Line items MUST be a <table> (Word engine collapses div/flex layouts).
* Complex payloads (many lines, quote/angle-bracket/ampersand characters)
  must arrive fully escaped and structurally intact.
"""

from syntropic.core.dispatch.draft_composer import compose_quote_draft


def _payload(**overrides):
    payload = {
        "event": "rfq.draft_requested",
        "job_id": "job-aaaabbbb-0000-0000-0000-000000000000",
        "filename": "rfq_acme.pdf",
        "quote_ingested_at": "2026-10-26T10:00:00+00:00",
        "recipient_email": "purchasing@acme.com",
        "payment_terms": "NET 45",
        "line_items": [
            {
                "part_number": "VALVE-SS-050",
                "description": '0.5" Ball Valve <High-Pressure> & Fittings',
                "quantity": 10,
                "unit_of_measure": "EA",
                "unit_price": 45.0,
            }
        ],
        "price_deltas": [],
        "margin_report": [],
    }
    payload.update(overrides)
    return payload


FORBIDDEN_MARKUP = (
    "<script",
    "<iframe",
    "<object",
    "<embed",
    "<link",
    "<style",
    "<form",
)


def test_no_active_content_or_style_blocks():
    html = compose_quote_draft(_payload())["html"]
    lowered = html.lower()
    for marker in FORBIDDEN_MARKUP:
        assert marker not in lowered, f"active/remote markup found: {marker}"


def test_no_external_resource_references():
    html = compose_quote_draft(_payload())["html"]
    lowered = html.lower()
    assert "src=" not in lowered, "remote/inline resource reference found"
    assert "url(" not in lowered, "CSS url() reference found"
    assert "http" not in lowered.replace("https://schemas.microsoft.com", ""), (
        "absolute URL leaked into draft HTML"
    )


def test_no_class_references_word_engine_safe_alignment():
    html = compose_quote_draft(_payload())["html"]
    assert "class=" not in html.lower(), (
        "class reference found — the draft ships no <style> block, so "
        "classes are inert and fragile in Outlook web"
    )
    assert html.count('align="right"') >= 4, (
        "numeric columns must right-align via the legacy align attribute"
    )


def test_line_items_are_table_based_with_terms_and_margin_footer():
    payload = _payload(
        line_items=[
            {
                "part_number": f"SKU-{i:03d}",
                "description": f"Line {i} item",
                "quantity": i + 1,
                "unit_of_measure": "EA",
                "unit_price": 10.0 + i,
            }
            for i in range(12)
        ]
    )
    draft = compose_quote_draft(payload)
    html = draft["html"]
    assert "<table" in html.lower() and "</table>" in html.lower()
    assert draft["line_count"] == 12
    assert "<strong>Total</strong>" in html
    assert "Terms:" in html and "NET 45" in html
    assert "Margin defense:" in html
    assert "Nothing is" in html and "click Send" in html  # HITL footer


def test_complex_payload_escapes_and_stays_structurally_intact():
    html = compose_quote_draft(_payload())["html"]
    # Dangerous characters must arrive escaped, never raw.
    assert "&lt;High-Pressure&gt;" in html
    assert "<High-Pressure>" not in html
    assert "&amp;" in html
    assert "&quot;" in html
    # The escaped description must still sit inside a table cell — the
    # escape must not break the document structure.
    assert html.count("<tr>") == 3  # header row + one line-item row + total row
    assert html.count("</th>") == 6  # thead: Part/Desc/Qty/UOM/Unit/Extended
    assert html.count("</td>") == 8  # line-item row (6) + tfoot total row (2)
