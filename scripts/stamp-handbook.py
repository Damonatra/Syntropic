"""Stamp footer page numbers + metadata on the operator handbook PDF.

Scheme (pagination.md standard): cover = hidden page 1; body pages show
Arabic numerals starting at 1. Zero-color law — gray stamp on dark ground.
"""
import fitz

SRC = "/home/z/my-project/download/vertebra-operator-handbook.pdf"
GRAY = (0x5F / 255, 0x64 / 255, 0x60 / 255)

doc = fitz.open(SRC)
for idx, page in enumerate(doc):
    if idx == 0:
        continue  # cover — number hidden, page 1 internally
    w, h = page.rect.width, page.rect.height
    page.insert_text(
        fitz.Point(w / 2 - 3, h - 22),
        str(idx),  # body numbering starts at 1
        fontsize=8,
        fontname="cour",
        color=GRAY,
    )

doc.set_metadata({
    "title": "Vertebra — Operator Handbook",
    "author": "Syntropic — Vertebra Margin Defense",
    "subject": "Quick-start handbook for operating the Vertebra enclave: gate, views, daily rhythm, engine loop, keyboard grammar",
    "creator": "Z.ai",
})
doc.saveIncr()
doc.close()
print("stamped pages 2..8 with body numbers 1..7 + metadata set")
