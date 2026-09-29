"""Generate a small sample RFQ PDF for local testing."""

import argparse
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


def generate_sample_rfq(output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    document = canvas.Canvas(str(output_path), pagesize=letter)
    document.setTitle("Sample RFQ")
    document.setFont("Helvetica-Bold", 16)
    document.drawString(72, 720, "Request for Quotation")
    document.setFont("Helvetica", 11)
    document.drawString(72, 680, "RFQ Number: SAMPLE-001")
    document.drawString(72, 656, "Part Number: VALVE-SS-050")
    document.drawString(72, 632, "Quantity: 10")
    document.save()
    return output_path


def main() -> None:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument(
        "output",
        nargs="?",
        type=Path,
        default=Path("outputs/sample_rfq.pdf"),
        help="Destination PDF path (default: outputs/sample_rfq.pdf)",
    )
    args = argument_parser.parse_args()
    generated_path = generate_sample_rfq(args.output)
    print(f"Generated sample RFQ: {generated_path}")


if __name__ == "__main__":
    main()