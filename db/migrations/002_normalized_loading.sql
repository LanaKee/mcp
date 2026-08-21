BEGIN;

ALTER TABLE policy_program
  ADD COLUMN IF NOT EXISTS ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id);

ALTER TABLE council_record
  ADD COLUMN IF NOT EXISTS ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id);

CREATE INDEX IF NOT EXISTS idx_policy_ingestion_run
  ON policy_program(ingestion_run_id);

CREATE INDEX IF NOT EXISTS idx_council_ingestion_run
  ON council_record(ingestion_run_id);

COMMIT;
