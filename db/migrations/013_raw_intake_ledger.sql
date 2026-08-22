-- Audit ledger for raw files entering the immutable dataset store.
-- Every intake decision is recorded, including files that never became facts,
-- so an operator can answer "what arrived, and why is it not in the warehouse?".

CREATE TABLE IF NOT EXISTS raw_intake_file (
  intake_file_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ingestion_run_id uuid NOT NULL REFERENCES ingestion_run(ingestion_run_id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_sha256 char(64) NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  media_type text NOT NULL,
  content_kind text NOT NULL,
  encoding text,
  reference_date date,
  action text NOT NULL CHECK (
    action IN ('accepted', 'revision', 'duplicate', 'quarantined')
  ),
  stored_path text,
  duplicate_of_path text,
  rejection_code text,
  rejection_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT raw_intake_file_stored_path_required CHECK (
    (action IN ('accepted', 'revision')) = (stored_path IS NOT NULL)
  ),
  CONSTRAINT raw_intake_file_rejection_required CHECK (
    (action = 'quarantined') = (rejection_code IS NOT NULL)
  ),
  CONSTRAINT raw_intake_file_duplicate_required CHECK (
    (action = 'duplicate') = (duplicate_of_path IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS raw_intake_file_sha256_idx
  ON raw_intake_file (file_sha256);

CREATE INDEX IF NOT EXISTS raw_intake_file_run_idx
  ON raw_intake_file (ingestion_run_id);

CREATE INDEX IF NOT EXISTS raw_intake_file_action_idx
  ON raw_intake_file (action, received_at DESC);

-- A stored path is the primary key of the raw store: it must never be reused.
CREATE UNIQUE INDEX IF NOT EXISTS raw_intake_file_stored_path_key
  ON raw_intake_file (stored_path)
  WHERE stored_path IS NOT NULL;
