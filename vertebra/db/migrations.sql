-- Vertebra schema (Neon Postgres / vanilla PG 15+).
-- Applied idempotently by vertebra.db.pool.Database.apply_migrations().

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- prospects
CREATE TABLE IF NOT EXISTS prospects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL,
    source_url      TEXT NOT NULL,
    name            TEXT NOT NULL,
    domain          TEXT,
    website         TEXT,
    vertical        TEXT,
    region          TEXT,
    city            TEXT,
    state_province  TEXT,
    country         TEXT,
    postal_code     TEXT,
    employee_count  INTEGER,
    revenue_estimate_usd BIGINT,
    revenue_confidence   TEXT NOT NULL DEFAULT 'unknown',
    detected_erp    TEXT,
    raw_excerpt     TEXT,
    scraped_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ingestion       TEXT NOT NULL DEFAULT 'pending',
    filter_reason   TEXT,
    casl_scope      BOOLEAN NOT NULL DEFAULT FALSE,
    casl_reason     TEXT,
    best_email      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN prospects.revenue_estimate_usd IS
    'Annual revenue estimate in USD; rows outside [10M, 150M] are filtered out.';

CREATE UNIQUE INDEX IF NOT EXISTS prospects_source_dedupe
    ON prospects (source, lower(coalesce(domain, name)));

CREATE INDEX IF NOT EXISTS prospects_vertical_idx  ON prospects (vertical);
CREATE INDEX IF NOT EXISTS prospects_region_idx    ON prospects (region);
CREATE INDEX IF NOT EXISTS prospects_ingestion_idx ON prospects (ingestion);
CREATE INDEX IF NOT EXISTS prospects_qlv_join_idx  ON prospects (domain);

-- ----------------------------------------------------------------- contacts
CREATE TABLE IF NOT EXISTS contacts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id   UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'unknown',
    title_raw     TEXT,
    linkedin_url  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_prospect_idx ON contacts (prospect_id);

-- --------------------------------------------------------- email candidates
CREATE TABLE IF NOT EXISTS email_candidates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id         UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
    address             TEXT NOT NULL,
    pattern             TEXT NOT NULL,
    domain              TEXT NOT NULL,
    is_casl_scope       BOOLEAN NOT NULL DEFAULT FALSE,
    syntax_valid        BOOLEAN NOT NULL DEFAULT FALSE,
    verified            BOOLEAN NOT NULL DEFAULT FALSE,
    verification_method TEXT NOT NULL DEFAULT 'none',
    smtp_code           INTEGER,
    verified_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_candidates_address_uniq
    ON email_candidates (lower(address));
CREATE INDEX IF NOT EXISTS email_candidates_prospect_idx
    ON email_candidates (prospect_id);

-- ------------------------------------------------------------------- scores
CREATE TABLE IF NOT EXISTS scores (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id        UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    qlv_score          INTEGER NOT NULL CHECK (qlv_score BETWEEN 1 AND 100),
    band               TEXT NOT NULL,
    factors            JSONB NOT NULL,
    hooks              JSONB NOT NULL,
    rationale          TEXT NOT NULL,
    model              TEXT NOT NULL,
    input_fingerprint  TEXT NOT NULL,
    scored_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scores_prospect_idx ON scores (prospect_id);
CREATE UNIQUE INDEX IF NOT EXISTS scores_fingerprint_uniq ON scores (input_fingerprint);

-- ----------------------------------------------------------------- dispatch
CREATE TABLE IF NOT EXISTS dispatches (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id    UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    channel        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','sending','sent','failed','suppressed','exported')),
    casl_scope     BOOLEAN NOT NULL DEFAULT FALSE,
    subject        TEXT,
    body           TEXT,
    from_domain    TEXT,
    provider       TEXT,
    provider_msg_id TEXT,
    footer_applied TEXT,
    send_after     TIMESTAMPTZ,
    sent_at        TIMESTAMPTZ,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispatches_status_idx    ON dispatches (status);
CREATE INDEX IF NOT EXISTS dispatches_channel_idx   ON dispatches (channel);
CREATE INDEX IF NOT EXISTS dispatches_send_after_idx ON dispatches (send_after)
    WHERE status = 'queued';

-- ------------------------------------------------- transactional outbox
CREATE TABLE IF NOT EXISTS outbox (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type TEXT NOT NULL,
    aggregate_id   TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    payload        JSONB NOT NULL,
    attempts       INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
    ON outbox (created_at) WHERE published_at IS NULL;

-- ------------------------------------------------------ high-touch queue
CREATE TABLE IF NOT EXISTS high_touch_queue (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id        UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    company_name       TEXT NOT NULL,
    contact_first      TEXT,
    contact_last       TEXT,
    role               TEXT,
    email              TEXT,
    phone              TEXT,
    city               TEXT,
    state_province     TEXT,
    region             TEXT NOT NULL,
    vertical           TEXT NOT NULL,
    qlv_score          INTEGER NOT NULL,
    qlv_band           TEXT NOT NULL,
    top_hook           TEXT NOT NULL,
    rationale          TEXT NOT NULL,
    detected_erp       TEXT,
    calendar_event_id  TEXT,
    exported_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS high_touch_export_idx ON high_touch_queue (exported_at);
