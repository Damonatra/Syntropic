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

## Tests

```bat
"%SYNTROPIC_VENV%\Scripts\python.exe" -m pytest -q
```

## Sprint 1 infrastructure

The API review queue uses PostgreSQL 16 through SQLAlchemy's asyncpg driver.
Alembic applies the review-job schema on API container startup, and the API
initializes LangGraph's async PostgreSQL checkpoint tables for durable workflow
state. All API routes other than `/health` require an OIDC-issued JWT access
token with an RS256 signature, configured issuer, and configured audience.
Existing local jobs in `outputs/review_queue.sqlite3` are not imported
automatically; keep that file as an archive and migrate any records you need
before retiring the old local review queue.

1. Copy `.env.example` to `.env`.
2. Set a unique PostgreSQL password and the OIDC issuer, API audience, and JWKS
   URL from your identity provider. Keep the `DATABASE_URL` credentials aligned
   with `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`; URL-encode any
   reserved characters in the password.
3. Start the stack with `docker compose up --build`.
4. Open the local Streamlit console at `http://localhost:8501` and paste an
   access token for the configured audience into the OIDC access token field.
   Token issuance/login remains the responsibility of the configured identity
   provider; the console does not collect user passwords.

Docker Compose binds the API and UI to loopback only. Do not publish these
ports directly to a public network; deploy behind TLS and an appropriately
configured ingress. The ERP node remains simulated.
