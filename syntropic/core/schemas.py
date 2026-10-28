# syntropic/core/schemas.py

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import instructor
from openai import OpenAI


# =====================================================================
# 1. CANONICAL DATA MODELS
# =====================================================================

class BoundingBoxCoord(BaseModel):
    left: float
    top: float
    right: float
    bottom: float
    coord_origin: str = "BOTTOMLEFT"


class Provenance(BaseModel):
    page_no: int
    bbox: BoundingBoxCoord


class CanonicalSKU(BaseModel):
    """Normalized, canonical representation of an industrial product SKU."""
    
    part_number: str = Field(
        ..., 
        description="Cleaned, standardized manufacturer or distributor part number (e.g., 'VALVE-SS-050')."
    )
    description: str = Field(
        ..., 
        description="Comprehensive product description normalized into standard trade terms."
    )
    quantity: int = Field(
        default=1, 
        description="Quantity requested in the line item. Must be a positive integer."
    )
    unit_of_measure: str = Field(
        default="EA", 
        description="Normalized unit of measure (e.g., 'EA', 'BOX', 'FT', 'LBS')."
    )
    unit_price: Optional[float] = Field(
        default=None, 
        description="Unit price as float if present, otherwise None."
    )
    currency: Optional[str] = Field(
        default=None,
        min_length=3,
        max_length=3,
        description="ISO 4217 currency code for the quoted unit price (e.g. 'USD').",
    )
    specifications: Dict[str, str] = Field(
        default_factory=dict,
        description="Key-value pairs of technical specifications (e.g., {'material': '316 SS', 'size': '0.5 in'})."
    )
    
    # Audit & Provenance Fields
    source_row_index: int = Field(
        ..., 
        description="The original table row index this SKU was extracted from."
    )
    provenance: List[Provenance] = Field(
        default_factory=list,
        description="Bounding box coordinates and page numbers linking back to the source PDF."
    )
    extraction_confidence: float = Field(
        ..., 
        ge=0.0, 
        le=1.0, 
        description="Model confidence score for this line item extraction (0.0 to 1.0)."
    )

    # -----------------------------------------------------------------
    # VALIDATION HOOKS (AUTOMATIC DATA CLEANING)
    # -----------------------------------------------------------------

    @field_validator("part_number")
    @classmethod
    def clean_part_number(cls, v: str) -> str:
        """Strip spaces, special chars, and force uppercase for SKU matching."""
        cleaned = v.strip().upper().replace(" ", "")
        if not cleaned:
            raise ValueError("Part number cannot be empty after trimming.")
        return cleaned

    @field_validator("quantity")
    @classmethod
    def validate_quantity(cls, v: int) -> int:
        if v <= 0:
            return 1  # Fallback safely to minimum 1 unit
        return v


class ExtractedCatalogQuote(BaseModel):
    """Container model representing a fully parsed catalog/RFQ document."""
    
    vendor_name: Optional[str] = Field(None, description="Identified vendor or manufacturer name.")
    rfq_number: Optional[str] = Field(None, description="RFQ, Purchase Order, or Quote reference identifier.")
    line_items: List[CanonicalSKU] = Field(
        default_factory=list, 
        description="List of standardized line-item SKUs extracted from the document."
    )
    overall_confidence_score: float = Field(
        0.0, 
        ge=0.0, 
        le=1.0, 
        description="Global confidence score for the entire extraction payload."
    )

    @model_validator(mode="after")
    def compute_global_confidence(self) -> "ExtractedCatalogQuote":
        """Calculates global confidence score as the average of all line-item confidence scores."""
        if not self.line_items:
            self.overall_confidence_score = 0.0
            return self

        total_score = sum(item.extraction_confidence for item in self.line_items)
        self.overall_confidence_score = round(total_score / len(self.line_items), 2)
        return self


# =====================================================================
# 2. INSTRUCTOR PARSING ENGINE
# =====================================================================

class SKUExtractionEngine:
    """Uses Instructor to map raw Docling table cells to CanonicalSKU models."""

    def __init__(self, api_key: Optional[str] = None, model: str = "gpt-4o-mini"):
        # Initialize OpenAI client wrapped with Instructor
        self.client = instructor.from_openai(OpenAI(api_key=api_key))
        self.model = model

    def parse_table_cells_to_skus(
        self, 
        table_cells: List[Dict[str, Any]], 
        num_rows: int
    ) -> ExtractedCatalogQuote:
        """
        Maps a list of raw table cell dicts (from DoclingPDFParser) into structured CanonicalSKU objects.
        """
        system_prompt = (
            "You are an expert industrial RFQ parser. "
            "Analyze the provided raw table cell grid and group cells by their `row_index`. "
            "Extract every line item into a standardized SKU object. "
            "Preserve cell bounding box provenance and page numbers exactly as provided in the input. "
            "Assign an honest `extraction_confidence` score (0.0 to 1.0) based on how clear and unambiguous the row data is."
        )

        user_prompt = f"""
        Document Table Details:
        - Total Rows: {num_rows}
        - Cell Grid Data:
        {table_cells}
        """

        # Instructor enforces output compliance against ExtractedCatalogQuote schema
        result: ExtractedCatalogQuote = self.client.chat.completions.create(
            model=self.model,
            response_model=ExtractedCatalogQuote,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.0,  # Zero temperature for deterministic extraction
        )

        return result


# =====================================================================
# 3. TYPESAFE AI JEV (JSON EVENT VERIFICATION) STREAM SCHEMAS
# =====================================================================

class RFQIngestedJEV(BaseModel):
    """Schema validator for rfq_ingested stream event payloads."""
    model_config = ConfigDict(extra="allow")
    filename_ext: Optional[str] = Field(default=None, description="File extension, e.g. 'pdf'")
    size_bytes: Optional[int] = Field(default=None, ge=0, description="Source file size in bytes")
    sha256_16: Optional[str] = Field(default=None, description="16-character SHA-256 hash prefix")


class OCRExtractedJEV(BaseModel):
    """Schema validator for ocr_extracted stream event payloads."""
    model_config = ConfigDict(extra="allow")
    text_chars: Optional[int] = Field(default=None, ge=0, description="Total extracted text characters")
    tables: Optional[int] = Field(default=None, ge=0, description="Count of extracted table structures")
    text_blocks: Optional[int] = Field(default=None, ge=0, description="Count of extracted text blocks")


class MarginAdjustedJEV(BaseModel):
    """Schema validator for margin_adjusted stream event payloads."""
    model_config = ConfigDict(extra="allow")
    decision: Optional[str] = Field(default=None, description="Margin defender decision: 'pass', 'veto', or 'reprice'")
    line_count: Optional[int] = Field(default=None, ge=1, description="Number of evaluated line items")
    repriced_count: Optional[int] = Field(default=None, ge=0, description="Number of repriced line items")
    veto_count: Optional[int] = Field(default=None, ge=0, description="Number of vetoed line items")
    margin_delta: Optional[float] = Field(default=None, description="Net margin price delta")
    sku_ids: Optional[List[str]] = Field(default=None, description="List of matched SKU IDs")
    margin_delta_by_currency: Optional[Dict[str, float]] = Field(
        default=None,
        description="Margin delta breakdown grouped by currency code"
    )


class DraftInjectedJEV(BaseModel):
    """Schema validator for draft_injected stream event payloads."""
    model_config = ConfigDict(extra="allow")
    sla_ms: Optional[int] = Field(default=None, ge=0, description="Execution SLA in milliseconds")
    sla_breached: Optional[bool] = Field(default=None, description="Flag indicating if execution breached SLA")
    line_count: Optional[int] = Field(default=None, ge=1, description="Number of draft quote line items")


JEV_SCHEMA_MAP = {
    "rfq_ingested": RFQIngestedJEV,
    "ocr_extracted": OCRExtractedJEV,
    "margin_adjusted": MarginAdjustedJEV,
    "draft_injected": DraftInjectedJEV,
}


def validate_jev_payload(event_type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Validates an event payload against its corresponding Typesafe AI JEV schema if defined."""
    schema = JEV_SCHEMA_MAP.get(event_type)
    if schema is None or not isinstance(payload, dict):
        return payload
    # Validate payload structure & types
    schema.model_validate(payload)
    return payload


# =====================================================================
# 4. VERIFICATION & LOCAL EXECUTION
# =====================================================================

if __name__ == "__main__":
    import json

    # Mock Docling cell output for testing
    mock_docling_cells = [
        # Row 0 (Headers)
        {"row_index": 0, "col_index": 0, "text": "Item #", "bounding_boxes": []},
        {"row_index": 0, "col_index": 1, "text": "Description", "bounding_boxes": []},
        {"row_index": 0, "col_index": 2, "text": "Qty", "bounding_boxes": []},
        {"row_index": 0, "col_index": 3, "text": "Price", "bounding_boxes": []},
        
        # Row 1 (Item 1)
        {
            "row_index": 1, 
            "col_index": 0, 
            "text": " vlv-ss-050 ", 
            "bounding_boxes": [{"page_no": 1, "bbox": {"left": 50.0, "top": 100.0, "right": 100.0, "bottom": 120.0, "coord_origin": "BOTTOMLEFT"}}]
        },
        {
            "row_index": 1, 
            "col_index": 1, 
            "text": "1/2 inch Stainless Steel Ball Valve 316SS", 
            "bounding_boxes": [{"page_no": 1, "bbox": {"left": 105.0, "top": 100.0, "right": 300.0, "bottom": 120.0, "coord_origin": "BOTTOMLEFT"}}]
        },
        {
            "row_index": 1, 
            "col_index": 2, 
            "text": "25", 
            "bounding_boxes": [{"page_no": 1, "bbox": {"left": 305.0, "top": 100.0, "right": 350.0, "bottom": 120.0, "coord_origin": "BOTTOMLEFT"}}]
        },
        {
            "row_index": 1, 
            "col_index": 3, 
            "text": "$45.50", 
            "bounding_boxes": [{"page_no": 1, "bbox": {"left": 355.0, "top": 100.0, "right": 400.0, "bottom": 120.0, "coord_origin": "BOTTOMLEFT"}}]
        },
    ]

    print("Executing Instructor Pydantic Schema Verification...")
    
    # Instantiate engine (Pass your key or set OPENAI_API_KEY environment variable)
    engine = SKUExtractionEngine()
    
    try:
        parsed_catalog = engine.parse_table_cells_to_skus(mock_docling_cells, num_rows=2)
        print("\n--- EXTRACTED CANONICAL QUOTE ---")
        print(json.dumps(parsed_catalog.model_dump(), indent=2))
        
        print(f"\nOverall Global Confidence Score: {parsed_catalog.overall_confidence_score}")
        if parsed_catalog.overall_confidence_score >= 0.85:
            print("Status: PASSED Syntropic Health Gate (Ready for ERP Push)")
        else:
            print("Status: FAILED Syntropic Health Gate (Rerouting to Self-Healing Loop)")

    except Exception as e:
        print(f"\nExecution failed (Ensure OPENAI_API_KEY is set): {e}")