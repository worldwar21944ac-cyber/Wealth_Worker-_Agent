-- kyc-gateway v6.0 D1 Schema
-- Run against AUDIT_DB (f2fe6105-b552-42b4-a2ca-9d2a349861da)

CREATE TABLE IF NOT EXISTS kyc_submissions (
  submission_id     TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL DEFAULT 'individual',
  applicant_name    TEXT NOT NULL,
  tin               TEXT,
  tin_formatted     TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  risk_score        INTEGER NOT NULL DEFAULT 0,
  risk_decision     TEXT NOT NULL DEFAULT 'REVIEW',
  risk_breakdown    TEXT,
  sanctions_hits    INTEGER DEFAULT 0,
  ofac_hits         INTEGER DEFAULT 0,
  pep_hits          INTEGER DEFAULT 0,
  tin_valid         INTEGER DEFAULT 1,
  ein_valid         INTEGER DEFAULT 1,
  screen_latency_ms INTEGER,
  raw_payload       TEXT,
  screened_at       TEXT,
  created_at        TEXT NOT NULL,
  flags_json        TEXT,
  pep_hits_json     TEXT,
  ofac_hits_json    TEXT,
  velocity_flagged  INTEGER DEFAULT 0,
  structuring_flagged INTEGER DEFAULT 0,
  adverse_media_hits INTEGER DEFAULT 0,
  engine_version    TEXT
);

CREATE TABLE IF NOT EXISTS kyc_review_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_id  TEXT NOT NULL,
  type          TEXT NOT NULL,
  flags_json    TEXT,
  payload_json  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  assigned_to   TEXT,
  resolved_by   TEXT,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kyc_beneficial_owners (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id    TEXT NOT NULL,
  owner_name       TEXT NOT NULL,
  ownership_pct    REAL DEFAULT 0,
  nationality      TEXT,
  is_flagged       INTEGER DEFAULT 0,
  sanctions_score  REAL DEFAULT 0,
  pep_flag         INTEGER DEFAULT 0,
  match_reason     TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_tin ON kyc_submissions(tin);
CREATE INDEX IF NOT EXISTS idx_submissions_decision ON kyc_submissions(risk_decision);
CREATE INDEX IF NOT EXISTS idx_submissions_created ON kyc_submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_queue_status ON kyc_review_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_ref ON kyc_review_queue(reference_id);
