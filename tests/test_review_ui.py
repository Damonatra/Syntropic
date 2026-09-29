from pathlib import Path
from unittest.mock import Mock

import fitz
import requests
from streamlit.testing.v1 import AppTest


APP_PATH = (
    Path(__file__).parents[1]
    / "syntropic"
    / "core"
    / "matching"
    / "api"
    / "ui"
    / "app.py"
)


def test_pending_review_renders_correction_controls(monkeypatch):
    job = {
        "job_id": "job-1",
        "filename": "quote.pdf",
        "status": "flagged_for_review",
        "execution_result": {
            "confidence_score": 1.0,
            "catalog_match_score": 0.31,
            "matched_catalog_item": {"part_number": "VALVE-SS-050"},
            "extracted_data": {"part_number": "VLV-SS-050", "quantity": 2},
            "execution_log": [
                "Flagged for Human Review: Catalog match score 0.31 below threshold."
            ],
        },
    }

    def mock_get(url, **kwargs):
        response = Mock(ok=True)
        if url.endswith("/reviews"):
            response.json.return_value = [
                {"job_id": job["job_id"], "filename": job["filename"]}
            ]
        elif url.endswith("/document"):
            pdf = fitz.open()
            pdf.new_page().insert_text((72, 72), "VLV-SS-050 2")
            response.content = pdf.tobytes()
            pdf.close()
        else:
            response.json.return_value = job
        return response

    monkeypatch.setattr(requests, "get", mock_get)
    app = AppTest.from_file(str(APP_PATH), default_timeout=10).run()

    assert not app.exception
    assert any(item.value == "Reviewer decision" for item in app.subheader)
    assert any(widget.label == "Part number" for widget in app.text_input)
    assert any(widget.label == "Quantity" for widget in app.number_input)
    assert any(widget.label == "PDF page" for widget in app.selectbox)