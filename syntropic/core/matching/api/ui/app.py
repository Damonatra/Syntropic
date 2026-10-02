# syntropic/ui/app.py

import os

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
API_BASE_URL = os.getenv(
    "SYNTROPIC_API_BASE_URL", "http://localhost:8000/api/v1/rfq"
)
PROCESS_URL = f"{API_BASE_URL}/process"
REVIEW_QUEUE_URL = f"{API_BASE_URL}/reviews"


def _api_headers() -> dict[str, str]:
    token = st.session_state.get("oidc_access_token", "").strip()
    return {"Authorization": f"Bearer {token}"} if token else {}


# Sidebar Navigation & Upload
pending_reviews = []
selected_review_id = None
with st.sidebar:
    st.header("Review queue")
    st.text_input(
        "OIDC access token",
        type="password",
        key="oidc_access_token",
        help="Paste an access token issued for the configured API audience.",
    )
    api_headers = _api_headers()
    try:
        queue_response = requests.get(
            REVIEW_QUEUE_URL, headers=api_headers, timeout=5
        )
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
            f"{REVIEW_QUEUE_URL}/{selected_review_id}",
            headers=_api_headers(),
            timeout=10,
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
            f"{REVIEW_QUEUE_URL}/{selected_review_id}/document",
            headers=_api_headers(),
            timeout=10,
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
            response = requests.post(
                PROCESS_URL, files=files, headers=_api_headers(), timeout=120
            )
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
        st.success("Workflow complete. ERP push is simulated.")
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
        matched_items = exec_res.get("matched_catalog_items", [])
        if matched_items:
            for index, line_match in enumerate(matched_items):
                catalog_item = line_match.get("catalog_item")
                st.markdown(f"**Line item {index + 1}**")
                if catalog_item:
                    st.json(catalog_item)
                else:
                    st.info("No catalog item matched this line.")
                st.caption(f"Match score: {line_match.get('rrf_score', 0.0):.2f}")
        elif matched_item:
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
            "Suggested catalog matches are kept only when their part numbers match your corrections."
        )
        review_line_items = extracted.get("line_items") or [extracted]
        with st.form(f"review_form_{data.get('job_id', '')}"):
            corrected_line_items = []
            for index, line_item in enumerate(review_line_items):
                part_label = "Part number" if index == 0 else f"Part number {index + 1}"
                quantity_label = "Quantity" if index == 0 else f"Quantity {index + 1}"
                part_number = st.text_input(
                    part_label,
                    value=str(line_item.get("part_number", "")),
                    key=f"review_part_number_{index}",
                )
                quantity = st.number_input(
                    quantity_label,
                    min_value=1,
                    value=int(line_item.get("quantity", 1) or 1),
                    step=1,
                    key=f"review_quantity_{index}",
                )
                corrected_line_items.append(
                    {"part_number": part_number, "quantity": quantity}
                )
            review_note = st.text_area("Review note", max_chars=1000)
            approve = st.form_submit_button("Approve RFQ", type="primary")
            reject = st.form_submit_button("Reject RFQ")

        if approve or reject:
            decision = "approve" if approve else "reject"
            payload = {"decision": decision, "note": review_note}
            if approve:
                payload["line_items"] = corrected_line_items
            try:
                response = requests.post(
                    f"{API_BASE_URL}/{data.get('job_id')}/review",
                    json=payload,
                    headers=_api_headers(),
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
