# syntropic/ui/app.py

import streamlit as st
import requests

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

if uploaded_file and process_button:
    with st.spinner("Extracting PDF text and matching the catalog..."):
        files = {"file": (uploaded_file.name, uploaded_file.getvalue(), "application/pdf")}
        try:
            response = requests.post(PROCESS_URL, files=files, timeout=120)
            if response.status_code == 200:
                st.session_state["result"] = response.json()
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