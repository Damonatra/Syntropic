"""PDF text extraction for inbound RFQ documents."""

from pathlib import Path

from pypdf import PdfReader


def parse_pdf_text(pdf_path: str | Path) -> str:
    """Return the extractable text from each page of a PDF."""
    return "\n".join(page.extract_text() or "" for page in PdfReader(pdf_path).pages)