import sys
from types import ModuleType, SimpleNamespace

import pytest

from syntropic.ingestion.parser import (
    PdfConversionError,
    parse_pdf_document,
    parse_pdf_text,
)


def test_docling_parser_uses_pdf_layout_and_ocr_pipeline(monkeypatch, tmp_path):
    options = SimpleNamespace()
    converter_arguments = {}
    pdf_format_options = []
    text_bbox = SimpleNamespace(
        l=1.234,
        t=2.345,
        r=30.456,
        b=40.567,
        coord_origin="TOPLEFT",
    )
    cell_bbox = SimpleNamespace(
        l=5.678,
        t=6.789,
        r=15.123,
        b=16.234,
        coord_origin="TOPLEFT",
    )
    table_item = SimpleNamespace(
        label="table",
        data=SimpleNamespace(
            num_rows=1,
            num_cols=2,
            table_cells=[
                SimpleNamespace(
                    start_row_offset_idx=0,
                    start_col_offset_idx=0,
                    text="Part\nNumber",
                    column_header=True,
                    bbox=cell_bbox,
                ),
                SimpleNamespace(
                    start_row_offset_idx=0,
                    start_col_offset_idx=1,
                    text="Quantity",
                    column_header=True,
                    bbox=cell_bbox,
                ),
            ],
        ),
        prov=[SimpleNamespace(page_no=1, bbox=text_bbox)],
    )
    text_item = SimpleNamespace(
        label=SimpleNamespace(value="text"),
        text="RFQ Header",
        prov=[SimpleNamespace(page_no=1, bbox=text_bbox)],
    )
    document_items = [text_item, table_item]

    class PdfFormatOption:
        def __init__(self, *, pipeline_options):
            converter_arguments["pipeline_options"] = pipeline_options
            pdf_format_options.append(self)

    class DocumentConverter:
        def __init__(self, *, format_options):
            converter_arguments["format_options"] = format_options

        def convert(self, path):
            converter_arguments["path"] = path
            return SimpleNamespace(
                document=SimpleNamespace(
                    export_to_markdown=lambda: "# Parsed RFQ\nPart Number: PIPE-1",
                    iterate_items=lambda: (
                        (item, 0) for item in document_items
                    ),
                )
            )

    modules = {
        "docling": ModuleType("docling"),
        "docling.datamodel": ModuleType("docling.datamodel"),
        "docling.datamodel.base_models": ModuleType(
            "docling.datamodel.base_models"
        ),
        "docling.datamodel.pipeline_options": ModuleType(
            "docling.datamodel.pipeline_options"
        ),
        "docling.document_converter": ModuleType("docling.document_converter"),
        "docling.exceptions": ModuleType("docling.exceptions"),
        "docling_core": ModuleType("docling_core"),
        "docling_core.types": ModuleType("docling_core.types"),
        "docling_core.types.doc": ModuleType("docling_core.types.doc"),
        "docling_core.types.doc.labels": ModuleType(
            "docling_core.types.doc.labels"
        ),
    }
    modules["docling.exceptions"].ConversionError = type(
        "ConversionError", (Exception,), {}
    )
    conversion_error = modules["docling.exceptions"].ConversionError
    modules["docling.datamodel.base_models"].InputFormat = SimpleNamespace(PDF="pdf")
    modules["docling.datamodel.pipeline_options"].PdfPipelineOptions = (
        lambda: options
    )
    modules["docling.document_converter"].DocumentConverter = DocumentConverter
    modules["docling.document_converter"].PdfFormatOption = PdfFormatOption
    modules["docling_core.types.doc.labels"].DocItemLabel = SimpleNamespace(
        TABLE="table"
    )
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)

    source = tmp_path / "rfq.pdf"
    source.write_bytes(b"%PDF test")
    text, payload = parse_pdf_document(source)

    assert text == "# Parsed RFQ\nPart Number: PIPE-1"
    assert options.do_ocr is True
    assert options.do_table_structure is True
    assert converter_arguments["path"] == str(source)
    assert converter_arguments["format_options"] == {
        "pdf": pdf_format_options[-1]
    }
    assert converter_arguments["pipeline_options"] is options
    assert payload["file_name"] == "rfq.pdf"
    assert payload["text_blocks"] == [
        {
            "label": "text",
            "text": "RFQ Header",
            "provenance": [
                {
                    "page_no": 1,
                    "bbox": {
                        "left": 1.23,
                        "top": 2.35,
                        "right": 30.46,
                        "bottom": 40.57,
                        "coord_origin": "TOPLEFT",
                    },
                }
            ],
        }
    ]
    assert payload["tables"][0]["num_rows"] == 1
    assert payload["tables"][0]["num_cols"] == 2
    assert payload["tables"][0]["cells"][0] == {
        "row_index": 0,
        "col_index": 0,
        "text": "Part\nNumber",
        "is_header": True,
        "provenance": [
            {
                "page_no": 1,
                "bbox": {
                    "left": 5.68,
                    "top": 6.79,
                    "right": 15.12,
                    "bottom": 16.23,
                    "coord_origin": "TOPLEFT",
                },
            }
        ],
    }
    assert payload["tables"][0]["cells"][1]["text"] == "Quantity"

    class FailingConverter(DocumentConverter):
        def convert(self, path):
            raise conversion_error(f"invalid PDF: {path}")

    modules["docling.document_converter"].DocumentConverter = FailingConverter
    with pytest.raises(PdfConversionError):
        parse_pdf_text(source)
