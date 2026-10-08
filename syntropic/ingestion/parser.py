"""Spatial PDF ingestion for inbound RFQ documents."""

from pathlib import Path
from typing import Any


class PdfConversionError(ValueError):
    """The PDF could not be converted into usable document content."""


class DoclingVisionParser:
    """Vision-enhanced Docling PDF ingestion with table and layout provenance."""

    def __init__(self, do_ocr: bool = True, do_table_structure: bool = True):
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption

        pipeline_options = PdfPipelineOptions()
        pipeline_options.do_ocr = do_ocr
        pipeline_options.do_table_structure = do_table_structure
        self.converter = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(
                    pipeline_options=pipeline_options
                )
            }
        )

    def _convert(self, pdf_path: str | Path) -> Any:
        from docling.exceptions import ConversionError

        path = Path(pdf_path)
        if not path.exists():
            raise FileNotFoundError(f"PDF not found: {path}")
        try:
            return self.converter.convert(str(path))
        except ConversionError as error:
            raise PdfConversionError(
                "Docling could not convert the uploaded PDF."
            ) from error

    def extract_rfq_payload(self, pdf_path: str | Path) -> dict[str, Any]:
        """Return text blocks, table grids, and page-coordinate provenance."""
        path = Path(pdf_path)
        document = self._convert(path).document
        return self._extract_document_payload(path, document)

    def _extract_document_payload(
        self, path: Path, document: Any
    ) -> dict[str, Any]:
        from docling_core.types.doc.labels import DocItemLabel

        tables: list[dict[str, Any]] = []
        text_blocks: list[dict[str, Any]] = []

        for item, _ in document.iterate_items():
            if getattr(item, "label", None) == DocItemLabel.TABLE:
                table_grid = self._parse_table_grid(item)
                if table_grid is not None:
                    tables.append(table_grid)
                continue

            text_content = getattr(item, "text", None)
            if text_content and text_content.strip():
                label = getattr(item, "label", None)
                text_blocks.append(
                    {
                        "label": getattr(label, "value", str(label or "text")),
                        "text": text_content.strip(),
                        "provenance": self._extract_bbox_provenance(item),
                    }
                )

        return {
            "file_name": path.name,
            "text_blocks": text_blocks,
            "tables": tables,
        }

    def _parse_table_grid(self, table_item: Any) -> dict[str, Any] | None:
        data = getattr(table_item, "data", None)
        table_cells = getattr(data, "table_cells", None)
        if table_cells is None:
            return None

        table_provenance = self._extract_bbox_provenance(table_item)
        cells = []
        for cell in table_cells:
            row_index = getattr(
                cell,
                "start_row_offset_idx",
                getattr(cell, "row_span_start", 0),
            )
            col_index = getattr(
                cell,
                "start_col_offset_idx",
                getattr(cell, "col_span_start", 0),
            )
            cells.append(
                {
                    "row_index": row_index,
                    "col_index": col_index,
                    "text": (getattr(cell, "text", None) or "").strip(),
                    "is_header": bool(getattr(cell, "column_header", False)),
                    "provenance": self._extract_bbox_provenance(
                        cell, page_provenance=table_provenance
                    ),
                }
            )

        return {
            "num_rows": getattr(data, "num_rows", 0),
            "num_cols": getattr(data, "num_cols", 0),
            "cells": cells,
        }

    @classmethod
    def _extract_bbox_provenance(
        cls, item: Any, *, page_provenance: list[dict[str, Any]] | None = None
    ) -> list[dict[str, Any]]:
        provenance = getattr(item, "prov", None) or []
        results = []
        for prov in provenance:
            bbox = getattr(prov, "bbox", None)
            if bbox is not None:
                results.append(cls._format_provenance_bbox(bbox, prov.page_no))
        if results:
            return results

        bbox = getattr(item, "bbox", None)
        if bbox is not None and page_provenance:
            return [
                cls._format_provenance_bbox(bbox, prov["page_no"])
                for prov in page_provenance
            ]
        return []

    @staticmethod
    def _format_provenance_bbox(bbox: Any, page_no: int) -> dict[str, Any]:
        return {
            "page_no": page_no,
            "bbox": {
                "left": round(bbox.l, 2),
                "top": round(bbox.t, 2),
                "right": round(bbox.r, 2),
                "bottom": round(bbox.b, 2),
                "coord_origin": str(bbox.coord_origin),
            },
        }


def parse_pdf_document(pdf_path: str | Path) -> tuple[str, dict[str, Any]]:
    """Convert a PDF once, returning Markdown for matching and spatial metadata."""
    parser = DoclingVisionParser()
    path = Path(pdf_path)
    conversion_result = parser._convert(path)
    document = conversion_result.document
    return document.export_to_markdown(), parser._extract_document_payload(path, document)


def parse_pdf_text(pdf_path: str | Path) -> str:
    """Convert a PDF with Docling layout analysis and OCR, returning Markdown."""
    markdown, _ = parse_pdf_document(pdf_path)
    return markdown
