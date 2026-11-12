BEGIN;

ALTER TABLE parking_lots
  ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_phone TEXT NOT NULL DEFAULT '';

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS first_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS identity_document TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';

ALTER TABLE parking_settings
  ADD COLUMN IF NOT EXISTS application_state JSONB NOT NULL
  DEFAULT '{"vehicles":[],"exitStack":[],"historyEvents":[]}'::jsonb;

ALTER TABLE parking_events
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  parking_lot_id UUID NOT NULL,
  account_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_account_same_parking_fk
    FOREIGN KEY (parking_lot_id, account_id)
    REFERENCES accounts (parking_lot_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at);

COMMIT;