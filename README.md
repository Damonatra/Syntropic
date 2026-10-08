# Syntropic
An open-source, event-driven agentic framework designed to orchestrate self-optimizing, adaptive AI workflows. Engineered for modularity, low-latency state synchronization, and scalable multi-agent execution in production environments.

## Local development

Use Python 3.12 from the project root.

```bat
set "PYTHON312=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
set "SYNTROPIC_VENV=%LOCALAPPDATA%\venvs\Syntropic312"
%PYTHON312% -m venv "%SYNTROPIC_VENV%"
"%SYNTROPIC_VENV%\Scripts\python.exe" -m pip install -r requirements-dev.txt
"%SYNTROPIC_VENV%\Scripts\python.exe" -m syntropic
```

This runs the packaged workflow demo and prints the final execution log plus the matched catalog item.

Run the Next.js audit workstation independently during frontend development:

```bat
cd syntropic-ui
npm install
npm run dev
```

The development server uses `NEXT_PUBLIC_API_BASE_URL`, which defaults to
`http://localhost:8000/api/v1`.

## Tests

```bat
"%SYNTROPIC_VENV%\Scripts\python.exe" -m pytest -q
```

## Sprint 1 infrastructure

The API review queue uses PostgreSQL 16 through SQLAlchemy's asyncpg driver.
Alembic applies the review-job schema on API container startup, and the API
initializes LangGraph's async PostgreSQL checkpoint tables for durable workflow
state. Docling performs OCR and table-structure extraction. The workflow retains
text-block and table-cell page provenance, including bounding-box coordinates
and multi-line header text, alongside the Markdown used for matching. A
deterministic normalization stage maps supported procurement UoM aliases to
`EA`, `BX`, `FT`, `IN`, `MTR`, `LBS`, or `KG` without converting quantities
between units. Trade dimensions such as `1/2 in` and `12.7 mm` are normalized
to inch-based matching text while retaining source measurements as SKU
specifications. Once confidence and catalog gates pass, the ERP sync graph
node normalizes each line item and marks it for dispatch. The API commits the
webhook event to the PostgreSQL outbox with the completed job; its asynchronous
worker signs and delivers the committed event using the configured
`WEBHOOK_URL` and `WEBHOOK_HMAC_SECRET`.
Approved ERP-ready jobs are inserted into a PostgreSQL webhook outbox in the
same transaction as the job. A background worker sends JSON with an
`X-Syntropic-Signature: sha256=<hex>` HMAC-SHA256 header and retries failures
up to eight times using exponential backoff capped at one hour; consumers
should deduplicate using `X-Syntropic-Event-ID`.
The `/health` liveness probe is public for container orchestration;
other API routes, including `/api/v1/health`, require an OIDC-issued JWT access
token with an RS256 signature, configured issuer, and configured audience.
Existing local jobs in `outputs/review_queue.sqlite3` are not imported
automatically; keep that file as an archive and migrate any records you need
before retiring the old local review queue.

1. Copy `.env.example` to `.env`.
2. Set a unique PostgreSQL password and the OIDC issuer, API audience, and JWKS
   URL from your identity provider. Register an OIDC public client with the
   Authorization Code + PKCE flow and the exact redirect URI configured by
   `OIDC_REDIRECT_URI`. Set its client ID in `OIDC_CLIENT_ID`, and replace
   `OIDC_STATE_SECRET` with a random secret of at least 32 bytes. The provider
   must issue RS256 access tokens for the configured API audience. Keep the
   `DATABASE_URL` credentials aligned with `POSTGRES_USER`,
   `POSTGRES_PASSWORD`, and `POSTGRES_DB`; URL-encode reserved characters in
   the password. Set `WEBHOOK_URL` to the ERP listener's HTTPS endpoint and
   `WEBHOOK_HMAC_SECRET` to an independent random secret of at least 32 bytes.
3. Start the stack with `docker compose up --build`.
4. Open `http://localhost:8000/api/v1/auth/authorize` in a browser to sign in
   with the identity provider. The API uses PKCE, validates the callback state,
   verifies the ID token nonce, and validates the returned access token's
   signature, issuer, audience, and expiry before returning it. The
   form-encoded `POST /api/v1/auth/token` endpoint exchanges an authorization
   code, PKCE verifier, OIDC nonce, and the configured redirect URI; it does
   not accept usernames or passwords.
5. Open the Next.js audit workstation at `http://localhost:3000`, use
   **Open identity provider** to start OIDC sign-in, then paste the validated
   access token returned by the API callback into the workstation.

Docker Compose binds the API and Next.js workstation to loopback only. Do not
publish these ports directly to a public network; deploy behind TLS and an
appropriately configured ingress. The ERP node remains simulated.

## Sprint 3: workstation, tracing, and evaluation

The Streamlit review console has been replaced by the Next.js 14/React audit
workstation, served at
`http://localhost:3000`. It polls the authenticated review queue, submits PDF
uploads and reviewer decisions to the FastAPI API, and renders source PDFs with
Docling text/table provenance boxes overlaid on the matching page. PDF files are
fetched with the current bearer token; the token is stored only in the browser
tab's session storage.

LangGraph runs can be traced to LangSmith by setting
`LANGSMITH_TRACING=true`, `LANGSMITH_ENDPOINT`, `LANGSMITH_API_KEY`, and
(optionally) `LANGSMITH_PROJECT` in `.env`, then restarting the API. The API
validates the key and configures the current LangSmith environment variables
and LangChain tracing compatibility variables. Tracing is disabled by default.
When enabled, LangSmith records the graph execution tree and node timing. The
health-gate node records its confidence, threshold, payload-validation result,
retry count, and approve/heal/review decision in the trace and execution log.

Model token usage is attached automatically by LangChain when a traced node
invokes a model that returns usage metadata. The current RFQ graph uses
deterministic extraction and catalog matching and has no LLM calls, so its runs
have no model token consumption to report. LangSmith receives workflow state,
which includes OCR text and extracted RFQ fields. Enable tracing only if your
organization's data-processing and retention policies allow those documents
to be sent to the configured LangSmith endpoint. Never commit the API key.

Run the offline evaluation against a UTF-8 JSONL dataset containing one labeled
example per line. Provide either `raw_text` or a `pdf_path` (relative to the
dataset file); expected item labels include `part_number`, `quantity`, and
optional `unit_of_measure`, and `expected_status` is `completed` or
`flagged_for_review`:

```json
{"id":"rfq-001","raw_text":"Part number: VALVE-SS-050\nQuantity: 2","expected_line_items":[{"part_number":"VALVE-SS-050","quantity":2,"unit_of_measure":"EA","expected_catalog_part_number":"VALVE-SS-050"}],"expected_status":"completed"}
```

```bat
"%SYNTROPIC_VENV%\Scripts\python.exe" -m syntropic.evaluation --dataset datasets\rfq-eval.jsonl --min-stp-accuracy 0.85
```

The `expected_catalog_part_number` on each item is also required for
`completed` examples so the catalog decision is scored rather than inferred
from extraction alone. The report includes exact extraction accuracy,
line-item precision/recall, catalog-match accuracy, workflow status accuracy,
straight-through rate, and STP accuracy (correct extraction, catalog match,
and expected completion among automatically completed examples). The command
exits non-zero when STP accuracy falls below the configured floor. No customer
RFQs or labels are bundled; provide an access-controlled dataset path when
running the evaluation. The GitHub Actions job checks the evaluator contract
and does not substitute for running it against that labeled corpus.
