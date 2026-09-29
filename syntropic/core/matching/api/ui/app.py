# syntropic/ui/app.py

import streamlit as st
import requests
import fitz
from PIL import Image, ImageDraw


@st.cache_data(show_spinner=False, max_entries=12)
def render_pdf_page(
    pdf_bytes: bytes, page_number: int, part_number: str, quantity: str
) -> Image.Image:
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        page = document.load_page(page_number)
        scale = 1.5
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
        draw = ImageDraw.Draw(image)

        for value, color in ((part_number, "#e5484d"), (quantity, "#168a63")):
            if not value:
                continue
            for rect in page.search_for(value):
                draw.rectangle(
                    (
                        rect.x0 * scale,
                        rect.y0 * scale,
                        rect.x1 * scale,
                        rect.y1 * scale,
                    ),
                    outline=color,
                    width=3,
                )
    return image

st.set_page_config(
    page_title="Syntropic Enterprise | HITL Review Console",
    layout="wide",
    initial_sidebar_state="expanded"
)

st.title("🛡️ Syntropic Enterprise Engine")
st.caption("Human-in-the-Loop Document Audit & Catalog Resolution")

# API Configuration
API_BASE_URL = "http://localhost:8000/api/v1/rfq"
PROCESS_URL = f"{API_BASE_URL}/process"
REVIEW_QUEUE_URL = f"{API_BASE_URL}/reviews"

# Sidebar Navigation & Upload
pending_reviews = []
selected_review_id = None
with st.sidebar:
    st.header("Review queue")
    try:
        queue_response = requests.get(REVIEW_QUEUE_URL, timeout=5)
        if queue_response.ok:
            pending_reviews = queue_response.json()
        else:
            st.caption("Review queue is unavailable.")
    except requests.RequestException:
        st.caption("Review queue is unavailable.")

    if pending_reviews:
        review_names = {
            item["job_id"]: item["filename"] for item in pending_reviews
        }
        selected_review_id = st.selectbox(
            "Pending RFQs",
            options=list(review_names),
            format_func=lambda job_id: review_names[job_id],
            key="pending_review_job_id",
        )
    else:
        st.caption("No pending reviews.")

    st.divider()
    st.header("Document Upload")
    uploaded_file = st.file_uploader("Upload Inbound RFQ PDF", type=["pdf"])
    process_button = st.button("Process Document", type="primary", use_container_width=True)

if selected_review_id and st.session_state.get("result", {}).get("job_id") != selected_review_id:
    try:
        response = requests.get(
            f"{REVIEW_QUEUE_URL}/{selected_review_id}", timeout=10
        )
        if response.ok:
            st.session_state["result"] = response.json()
        else:
            st.error(f"Could not load review: {response.text}")
    except requests.RequestException as e:
        st.error(f"Could not connect to the review queue.\nError: {e}")

if selected_review_id and st.session_state.get("source_pdf_job_id") != selected_review_id:
    try:
        response = requests.get(
            f"{REVIEW_QUEUE_URL}/{selected_review_id}/document", timeout=10
        )
        st.session_state["source_pdf"] = response.content if response.ok else None
        st.session_state["source_pdf_job_id"] = selected_review_id
    except requests.RequestException:
        st.session_state["source_pdf"] = None
        st.session_state["source_pdf_job_id"] = selected_review_id

if uploaded_file and process_button:
    with st.spinner("Extracting PDF text and matching the catalog..."):
        files = {"file": (uploaded_file.name, uploaded_file.getvalue(), "application/pdf")}
        try:
            response = requests.post(PROCESS_URL, files=files, timeout=120)
            if response.status_code == 200:
                st.session_state["result"] = response.json()
                st.session_state["source_pdf"] = uploaded_file.getvalue()
                st.session_state["source_pdf_job_id"] = st.session_state["result"].get("job_id")
                st.success("Pipeline Execution Complete!")
            else:
                st.error(f"API Error: {response.text}")
        except Exception as e:
            st.error(f"Failed to connect to API Gateway at {PROCESS_URL}. Ensure uvicorn is running.\nError: {e}")

# Display Active Review Dashboard
if "result" in st.session_state:
    data = st.session_state["result"]
    exec_res = data.get("execution_result", {})
    extraction_confidence = exec_res.get("confidence_score", 0.0)
    catalog_match_score = exec_res.get("catalog_match_score", 0.0)
    matched_item = exec_res.get("matched_catalog_item")
    status = data.get("status", "unknown")

    st.markdown("---")
    
    with st.container(horizontal=True):
        st.metric("Job ID", data.get("job_id", "")[:8])
        st.metric("Extraction confidence", f"{extraction_confidence:.2f}")
        st.metric("Catalog match score", f"{catalog_match_score:.2f}")

    if status == "completed":
        st.success("Workflow complete. ERP commit succeeded.")
    elif status == "flagged_for_review":
        st.warning("Human review required before this RFQ can proceed.")
    elif status == "rejected":
        st.error("This RFQ was rejected and will not be committed.")
    else:
        st.info(f"Workflow status: {status}")

    st.markdown("### Processed RFQ")

    extracted = exec_res.get("extracted_data", {})
    col_left, col_right = st.columns([1, 1])

    with col_left:
        st.subheader("Extracted RFQ fields")
        if extracted:
            st.json(extracted)
        else:
            st.info("No RFQ fields were extracted.")

    with col_right:
        st.subheader("Catalog match")
        if matched_item:
            st.json(matched_item)
        else:
            st.info("No catalog item was matched.")

    st.subheader("Source document")
    source_pdf = st.session_state.get("source_pdf")
    if isinstance(source_pdf, bytes):
        try:
            with fitz.open(stream=source_pdf, filetype="pdf") as document:
                page_count = document.page_count
            page_number = st.selectbox(
                "PDF page",
                options=range(page_count),
                format_func=lambda page: f"Page {page + 1}",
                key=f"source_pdf_page_{data.get('job_id', '')}",
            )
            page_image = render_pdf_page(
                source_pdf,
                page_number,
                str(extracted.get("part_number", "")),
                str(extracted.get("quantity", "")),
            )
            st.image(page_image, width="stretch")
            st.caption(":red[Part number]  :green[Quantity]")
        except (fitz.FileDataError, ValueError) as error:
            st.warning(f"The source PDF could not be displayed: {error}")
    else:
        st.info("The source PDF is unavailable for this review.")

    if status == "flagged_for_review":
        st.subheader("Reviewer decision")
        st.caption(
            "The suggested match is kept only when its part number matches your correction; otherwise approval commits the RFQ as unmatched."
        )
        with st.form(f"review_form_{data.get('job_id', '')}"):
            part_number = st.text_input(
                "Part number",
                value=str(extracted.get("part_number", "")),
            )
            quantity = st.number_input(
                "Quantity",
                min_value=1,
                value=int(extracted.get("quantity", 1) or 1),
                step=1,
            )
            review_note = st.text_area("Review note", max_chars=1000)
            approve = st.form_submit_button("Approve and commit", type="primary")
            reject = st.form_submit_button("Reject RFQ")

        if approve or reject:
            decision = "approve" if approve else "reject"
            payload = {"decision": decision, "note": review_note}
            if approve:
                payload.update({"part_number": part_number, "quantity": quantity})
            try:
                response = requests.post(
                    f"{API_BASE_URL}/{data.get('job_id')}/review",
                    json=payload,
                    timeout=20,
                )
                if response.ok:
                    st.session_state["result"] = response.json()
                    st.rerun()
                else:
                    st.error(f"Review action failed: {response.text}")
            except requests.RequestException as e:
                st.error(f"Could not submit the review decision.\nError: {e}")

    st.subheader("Execution log")
    for log in exec_res.get("execution_log", []):
        st.info(log)
     # syntropic/ui/app.py

import streamlit as st
import requests
import json
import fitz  # PyMuPDF
from PIL import Image, ImageDraw
from pathlib import Path
import io

st.set_page_config(
    page_title="Syntropic Enterprise Console",
    layout="wide",
    initial_sidebar_state="expanded"
)

st.title("🛡️ Syntropic Enterprise Engine")
st.caption("Precision RFQ Parsing & Visual Bounding Box Audit Console")

API_URL = "http://localhost:8000/api/v1/rfq/process"

def render_pdf_page_with_boxes(pdf_bytes: bytes, page_number: int, bboxes: list) -> Image.Image:
    """Renders a PDF page to a PIL Image with spatial bounding box highlights."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc.load_page(page_number - 1)
    pix = page.get_pixmap(dpi=150)
    
    img = Image.open(io.BytesIO(pix.tobytes()))
    draw = ImageDraw.Draw(img, "RGBA")
    
    # Render spatial bounding boxes on canvas
    for bbox in bboxes:
        # Bbox format: left, top, right, bottom (normalized coordinates)
        x0, y0, x1, y1 = bbox["left"], bbox["top"], bbox["right"], bbox["bottom"]
        
        # Scale coordinates to image DPI dimensions
        scale_x = img.width / page.rect.width
        scale_y = img.height / page.rect.height
        
        box_coords = [x0 * scale_x, y0 * scale_y, x1 * scale_x, y1 * scale_y]
        
        # Draw translucent highlight box
        draw.rectangle(box_coords, fill=(37, 99, 235, 60), outline=(37, 99, 235, 255), width=2)
        
    return img

with st.sidebar:
    st.header("Document Ingestion")
    uploaded_file = st.file_uploader("Upload RFQ PDF", type=["pdf"])
    process_button = st.button("Execute Syntropic Engine", type="primary", use_container_width=True)

if uploaded_file and process_button:
    file_bytes = uploaded_file.getvalue()
    st.session_state["raw_pdf_bytes"] = file_bytes
    
    with st.spinner("Processing through Docling -> Instructor -> Qdrant -> LangGraph..."):
        files = {"file": (uploaded_file.name, file_bytes, "application/pdf")}
        try:
            response = requests.post(API_URL, files=files)
            if response.status_code == 200:
                st.session_state["result"] = response.json()
                st.success("Execution Complete!")
            else:
                st.error(f"API Exception: {response.text}")
        except Exception as e:
            st.error(f"Failed to connect to API Gateway at {API_URL}: {e}")

if "result" in st.session_state:
    data = st.session_state["result"]
    exec_res = data.get("execution_result", {})
    confidence = exec_res.get("confidence_score", 0.0)

    st.markdown("---")
    m1, m2, m3 = st.columns(3)
    m1.metric("Job Reference", data.get("job_id", "")[:8])
    m2.metric("Overall Confidence", f"{confidence:.2f}")
    if confidence >= 0.85:
        m3.success("GATE PASSED: Automatic ERP Sync Ready")
    else:
        m3.warning("GATE FLAGGED: Human Audit Required")

    col_left, col_right = st.columns([1, 1])

    with col_left:
        st.subheader("Extracted SKUs & Provenance")
        line_items = exec_res.get("extracted_data", {}).get("line_items", [])
        
        selected_item_idx = st.selectbox(
            "Select Line Item to Audit Bounding Box",
            options=range(len(line_items)),
            format_func=lambda i: f"Row {line_items[i].get('source_row_index')}: {line_items[i].get('part_number')} - {line_items[i].get('description')[:30]}..."
        ) if line_items else None

        if selected_item_idx is not None:
            st.json(line_items[selected_item_idx])

    with col_right:
        st.subheader("Visual Document Inspection Canvas")
        if selected_item_idx is not None and "raw_pdf_bytes" in st.session_state:
            item = line_items[selected_item_idx]
            provenance = item.get("provenance", [])
            
            if provenance:
                page_no = provenance[0].get("page_no", 1)
                bboxes = [p["bbox"] for p in provenance if "bbox" in p]
                
                annotated_img = render_pdf_page_with_boxes(
                    st.session_state["raw_pdf_bytes"], 
                    page_number=page_no, 
                    bboxes=bboxes
                )
                st.image(annotated_img, caption=f"Page {page_no} - Line Item Spatial Extraction Box", use_container_width=True)
            else:
                st.info("No spatial bounding boxes available for this line item.")   