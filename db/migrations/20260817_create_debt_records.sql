-- db/migrations/20260817_create_debt_records.sql

-- Migration: create debt_records table for the Debt Sovereignty Ledger (DSL)
-- Adds consent and payout flags; payout processing is gated by ENABLE_PAYOUTS env var.

CREATE TABLE IF NOT EXISTS debt_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  creditor TEXT NOT NULL,
  amount_minor INTEGER NOT NULL, -- cents
  due_date TEXT,
  category TEXT, -- cell, medical, student, auto, credit, utility, other
  status TEXT DEFAULT 'active', -- active, settled, disputed, defaulted
  image_ref TEXT, -- R2 key or other object reference
  created_at TEXT DEFAULT (datetime('now')),
  verified INTEGER DEFAULT 0,
  consent_given INTEGER DEFAULT 0, -- explicit user consent (0/1)
  payout_queued INTEGER DEFAULT 0, -- set when a payout is scheduled (0/1)
  payout_amount_minor INTEGER DEFAULT 0,
  redacted INTEGER DEFAULT 0 -- 0 = original stored, 1 = redacted for privacy
);
