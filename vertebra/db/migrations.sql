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

-- ============================================================================ --
--  MODULES 5-9 — advanced tactical extensions
-- ============================================================================ --

-- PostGIS is optional: every spatial query in vertebra.spatial.clustering has
-- a deterministic haversine fallback, so a missing extension degrades gently.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS postgis;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'postgis unavailable — spatial module runs in haversine fallback mode';
END $$;

-- Contacts gain a direct line for the Module 8 high-intent alert template.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone TEXT;

-- ---------------------------------------------------- Module 5: ERP metadata
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS erp_metadata      JSONB;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS quote_portal_type TEXT;

-- ------------------------------------------- Module 6: audit preview asset --
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS audit_image_url TEXT;

-- ------------------------------------ Module 7: geocoding + cluster binding --
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS lead_clusters (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_key    TEXT NOT NULL UNIQUE,
    cluster_name   TEXT NOT NULL,
    anchor_city    TEXT,
    anchor_country TEXT,
    centroid_lat   DOUBLE PRECISION NOT NULL,
    centroid_lng   DOUBLE PRECISION NOT NULL,
    radius_m       INTEGER NOT NULL DEFAULT 0,
    density_count  INTEGER NOT NULL DEFAULT 0,
    vertical_focus TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE lead_clusters ADD COLUMN IF NOT EXISTS centroid_geog geography(Point, 4326);
    CREATE INDEX IF NOT EXISTS lead_clusters_geog_idx ON lead_clusters USING GIST (centroid_geog);
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'lead_clusters geography column skipped (postgis unavailable)';
END $$;

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS cluster_id UUID REFERENCES lead_clusters(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS prospects_cluster_idx ON prospects (cluster_id);
CREATE INDEX IF NOT EXISTS prospects_geo_idx     ON prospects (latitude, longitude)
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS prospects_portal_idx  ON prospects (quote_portal_type)
    WHERE quote_portal_type IS NOT NULL;

-- ------------------------------------------------- Module 8: visitor telemetry
CREATE TABLE IF NOT EXISTS telemetry_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id  UUID REFERENCES prospects(id) ON DELETE SET NULL,
    session_id   TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    url          TEXT,
    referrer     TEXT,
    city         TEXT,
    country      TEXT,
    latitude     DOUBLE PRECISION,
    longitude    DOUBLE PRECISION,
    user_agent   TEXT,
    device       TEXT,
    duration_ms  INTEGER,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telemetry_prospect_idx ON telemetry_events (prospect_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_session_idx  ON telemetry_events (session_id);
CREATE INDEX IF NOT EXISTS telemetry_type_idx     ON telemetry_events (event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS intent_alerts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id        UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    body               TEXT NOT NULL,
    dedupe_key         TEXT,
    channels_attempted TEXT[] NOT NULL DEFAULT '{}',
    channels_delivered TEXT[] NOT NULL DEFAULT '{}',
    delivered          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intent_alerts_dedupe_idx  ON intent_alerts (dedupe_key, created_at DESC);
CREATE INDEX IF NOT EXISTS intent_alerts_prospect_idx ON intent_alerts (prospect_id, created_at DESC);

-- ------------------------------------------- Module 9: replies + agent drafts
CREATE TABLE IF NOT EXISTS inbound_replies (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id       UUID REFERENCES prospects(id) ON DELETE SET NULL,
    message_id        TEXT,
    from_email        TEXT NOT NULL,
    subject           TEXT,
    body              TEXT NOT NULL,
    intent            TEXT NOT NULL DEFAULT 'unknown',
    intent_confidence DOUBLE PRECISION,
    rationale         TEXT,
    extracted         JSONB,
    processed_at      TIMESTAMPTZ,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_replies_unprocessed_idx
    ON inbound_replies (received_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS inbound_replies_prospect_idx
    ON inbound_replies (prospect_id, received_at DESC);

CREATE TABLE IF NOT EXISTS agent_drafts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reply_id      UUID NOT NULL REFERENCES inbound_replies(id) ON DELETE CASCADE,
    prospect_id   UUID REFERENCES prospects(id) ON DELETE SET NULL,
    intent        TEXT NOT NULL,
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending_human_review'
                  CHECK (status IN ('pending_human_review','approved','sent','discarded')),
    reviewer_note TEXT,
    sent_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_drafts_status_idx ON agent_drafts (status, created_at);

-- ------------------------- Console loop-closure: operator decision log -------
CREATE TABLE IF NOT EXISTS operator_actions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    action     TEXT NOT NULL CHECK (action IN ('called','deferred','snoozed','booked','note')),
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_actions_prospect_idx ON operator_actions (prospect_id, created_at DESC);

-- ------------------------- Console loop-closure: CASL suppression ledger -----
CREATE TABLE IF NOT EXISTS suppressions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL UNIQUE,
    prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
    reason      TEXT NOT NULL DEFAULT 'unsubscribe'
                CHECK (reason IN ('unsubscribe','complaint','bounce','manual')),
    source      TEXT NOT NULL DEFAULT 'unsubscribe_link'
                CHECK (source IN ('unsubscribe_link','one_click','operator','engine')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS suppressions_prospect_idx ON suppressions (prospect_id);

-- ------------------------- Console loop-closure: audit intake ----------------
CREATE TABLE IF NOT EXISTS audit_documents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id   UUID REFERENCES prospects(id) ON DELETE SET NULL,
    file_name     TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    pages         INTEGER,
    line_items    INTEGER,
    extraction    TEXT NOT NULL DEFAULT 'partial'
                  CHECK (extraction IN ('full_text','partial','header_only')),
    findings      JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_documents_created_idx ON audit_documents (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_documents_sha_idx ON audit_documents (sha256);

ALTER TABLE intent_alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

-- ------------------------- Module 8: rolling intent heat on the prospect ----
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS intent_heat INTEGER NOT NULL DEFAULT 0;
