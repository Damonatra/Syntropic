"""Merge AAR cover + body into the final deliverable PDF."""
from pypdf import PdfReader, PdfWriter

A4_W, A4_H = 595.28, 841.89

COVER = '/home/z/my-project/scripts/aar-cover.pdf'
BODY = '/home/z/my-project/scripts/aar-body.pdf'
OUT = '/home/z/my-project/download/Syntropic-Backbone-After-Action-Report.pdf'


def normalize_page_to_a4(page):
    box = page.mediabox
    w, h = float(box.width), float(box.height)
    if abs(w - A4_W) > 0.1 or abs(h - A4_H) > 0.1:
        page.scale_to(A4_W, A4_H)
    return page


writer = PdfWriter()
cover_page = PdfReader(COVER).pages[0]
writer.add_page(normalize_page_to_a4(cover_page))
for page in PdfReader(BODY).pages:
    writer.add_page(normalize_page_to_a4(page))
writer.add_metadata({
    '/Title': 'Syntropic Backbone - After Action Report',
    '/Author': 'Z.ai',
    '/Creator': 'Z.ai',
    '/Subject': 'After action report for the Syntropic Backbone build programme',
})
with open(OUT, 'wb') as f:
    writer.write(f)

r = PdfReader(OUT)
sizes = {(round(float(p.mediabox.width), 1), round(float(p.mediabox.height), 1)) for p in r.pages}
print('final:', OUT, '| pages:', len(r.pages), '| sizes:', sizes)
