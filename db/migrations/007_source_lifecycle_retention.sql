BEGIN;

SET LOCAL max_parallel_maintenance_workers = 0;

CREATE TABLE IF NOT EXISTS pdf_processing_version (
  version_key text PRIMARY KEY,
  extractor_version text NOT NULL,
  chunker_version text NOT NULL,
  approval_state text NOT NULL CHECK (
    approval_state IN ('candidate', 'approved', 'retired')
  ),
  activated_at timestamptz,
  activated_by text,
  activation_reason text,
  retired_at timestamptz,
  retired_by text,
  retirement_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (extractor_version, chunker_version)
);

CREATE TABLE IF NOT EXISTS pdf_processing_version_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_key text NOT NULL REFERENCES pdf_processing_version(version_key),
  action text NOT NULL CHECK (action IN ('seed', 'approve', 'rollback', 'retire')),
  actor text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE document_chunk
  ADD COLUMN IF NOT EXISTS processing_version_key text,
  ADD COLUMN IF NOT EXISTS approved_current boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS stale_at timestamptz;

ALTER TABLE document_page
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS stale_at timestamptz;

ALTER TABLE source_locator
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE document_chunk chunk
   SET created_at = run.started_at
  FROM ingestion_run run
 WHERE chunk.ingestion_run_id = run.ingestion_run_id
   AND chunk.created_at > run.started_at;

UPDATE document_page page
   SET created_at = run.started_at
  FROM ingestion_run run
 WHERE page.ingestion_run_id = run.ingestion_run_id
   AND page.created_at > run.started_at;

INSERT INTO pdf_processing_version (
  version_key,
  extractor_version,
  chunker_version,
  approval_state,
  retired_at,
  retired_by,
  retirement_reason,
  metadata
)
SELECT DISTINCT
  coalesce(metadata->>'extractorVersion', 'legacy-unknown')
    || '::'
    || coalesce(metadata->>'chunkerVersion', 'legacy-unknown'),
  coalesce(metadata->>'extractorVersion', 'legacy-unknown'),
  coalesce(metadata->>'chunkerVersion', 'legacy-unknown'),
  'retired',
  now(),
  'migration:007',
  'Seeded as retained historical processing output',
  jsonb_build_object('seededByMigration', 7)
FROM document_chunk
ON CONFLICT (version_key) DO NOTHING;

UPDATE document_chunk
   SET processing_version_key =
     coalesce(metadata->>'extractorVersion', 'legacy-unknown')
       || '::'
       || coalesce(metadata->>'chunkerVersion', 'legacy-unknown')
 WHERE processing_version_key IS NULL;

WITH active AS (
  SELECT processing_version_key
    FROM document_chunk
   WHERE is_current
   GROUP BY processing_version_key
   ORDER BY count(*) DESC, processing_version_key
   LIMIT 1
),
needs_seed AS (
  SELECT true AS value
  WHERE NOT EXISTS (
    SELECT 1
      FROM pdf_processing_version
     WHERE approval_state = 'approved'
  )
)
UPDATE pdf_processing_version version
   SET approval_state = 'approved',
       activated_at = now(),
       activated_by = 'migration:007',
       activation_reason = 'Preserved the existing current production version',
       retired_at = NULL,
       retired_by = NULL,
       retirement_reason = NULL,
       updated_at = now()
  FROM active, needs_seed
 WHERE version.version_key = active.processing_version_key;

INSERT INTO pdf_processing_version_event (
  version_key,
  action,
  actor,
  reason,
  metadata
)
SELECT
  version_key,
  'seed',
  coalesce(activated_by, retired_by, 'migration:007'),
  coalesce(activation_reason, retirement_reason, 'Seeded lifecycle state'),
  jsonb_build_object('approvalState', approval_state)
FROM pdf_processing_version
WHERE NOT EXISTS (
  SELECT 1
    FROM pdf_processing_version_event event
   WHERE event.version_key = pdf_processing_version.version_key
);

UPDATE document_chunk chunk
   SET is_current = false,
       approved_current = false,
       stale_at = coalesce(stale_at, now())
 WHERE NOT EXISTS (
   SELECT 1
     FROM pdf_processing_version version
    WHERE version.version_key = chunk.processing_version_key
      AND version.approval_state = 'approved'
 )
   AND (
    chunk.is_current
    OR chunk.approved_current
    OR chunk.stale_at IS NULL
   );

UPDATE document_chunk chunk
   SET approved_current = true,
      stale_at = NULL
 WHERE chunk.is_current
   AND (
    NOT chunk.approved_current
    OR chunk.stale_at IS NOT NULL
   )
   AND EXISTS (
     SELECT 1
       FROM pdf_processing_version version
      WHERE version.version_key = chunk.processing_version_key
        AND version.approval_state = 'approved'
   );

UPDATE document_chunk
   SET stale_at = coalesce(stale_at, now())
 WHERE NOT is_current
   AND stale_at IS NULL;

ALTER TABLE document_chunk
  ALTER COLUMN processing_version_key SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'document_chunk_processing_version_key_fkey'
  ) THEN
    ALTER TABLE document_chunk
      ADD CONSTRAINT document_chunk_processing_version_key_fkey
      FOREIGN KEY (processing_version_key)
      REFERENCES pdf_processing_version(version_key);
  END IF;
END $$;

UPDATE document_page
   SET stale_at = CASE WHEN is_current THEN NULL ELSE now() END
 WHERE (is_current AND stale_at IS NOT NULL)
    OR (NOT is_current AND stale_at IS NULL);

CREATE TABLE IF NOT EXISTS document_processing_version (
  document_id uuid NOT NULL REFERENCES document(document_id) ON DELETE CASCADE,
  version_key text NOT NULL REFERENCES pdf_processing_version(version_key) ON DELETE CASCADE,
  extraction_status text NOT NULL CHECK (
    extraction_status IN (
      'extracted',
      'partial',
      'ocr_required',
      'extraction_failed',
      'password_required'
    )
  ),
  page_count integer NOT NULL CHECK (page_count >= 0),
  content_sha256 char(64) NOT NULL,
  data_status text NOT NULL CHECK (
    data_status IN ('official_observed', 'demo_sample', 'catalog_only')
  ),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  stale_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (document_id, version_key)
);

INSERT INTO document_processing_version (
  document_id,
  version_key,
  extraction_status,
  page_count,
  content_sha256,
  data_status,
  ingestion_run_id,
  created_at,
  stale_at,
  metadata
)
SELECT DISTINCT
  document_row.document_id,
  chunk.processing_version_key,
  document_row.extraction_status,
  document_row.page_count,
  document_row.content_sha256,
  document_row.data_status,
  document_row.ingestion_run_id,
  coalesce(run.started_at, now()),
  CASE WHEN version.approval_state = 'approved' THEN NULL ELSE now() END,
  document_row.metadata
FROM document document_row
JOIN document_chunk chunk
  ON chunk.document_id = document_row.document_id
JOIN pdf_processing_version version
  ON version.version_key = chunk.processing_version_key
LEFT JOIN ingestion_run run
  ON run.ingestion_run_id = document_row.ingestion_run_id
ON CONFLICT (document_id, version_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS storage_maintenance_run (
  maintenance_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation text NOT NULL CHECK (
    operation IN ('stale_purge', 'audit_purge', 'analyze', 'vacuum')
  ),
  status text NOT NULL CHECK (
    status IN ('planned', 'running', 'partial', 'succeeded', 'failed')
  ),
  dry_run boolean NOT NULL,
  requested_by text NOT NULL,
  plan_token char(64),
  retention_days integer CHECK (retention_days IS NULL OR retention_days >= 0),
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_report jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS mcp_tool_audit_daily (
  audit_date date NOT NULL,
  tool_name text NOT NULL,
  success boolean NOT NULL,
  repository_mode text NOT NULL CHECK (repository_mode IN ('memory', 'postgres')),
  call_count bigint NOT NULL CHECK (call_count >= 0),
  result_count_sum bigint NOT NULL CHECK (result_count_sum >= 0),
  duration_ms_sum bigint NOT NULL CHECK (duration_ms_sum >= 0),
  duration_ms_max integer NOT NULL CHECK (duration_ms_max >= 0),
  last_aggregated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audit_date, tool_name, success, repository_mode)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_processing_one_approved
  ON pdf_processing_version((approval_state))
  WHERE approval_state = 'approved';
CREATE INDEX IF NOT EXISTS idx_pdf_processing_state
  ON pdf_processing_version(approval_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pdf_processing_event
  ON pdf_processing_version_event(version_key, occurred_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class index_row
      JOIN pg_index index_definition
        ON index_definition.indexrelid = index_row.oid
     WHERE index_row.relname = 'idx_chunk_fts'
       AND coalesce(
         pg_get_expr(index_definition.indpred, index_definition.indrelid),
         ''
       ) LIKE '%approved_current%'
  ) THEN
    DROP INDEX IF EXISTS idx_chunk_fts;
    CREATE INDEX idx_chunk_fts
      ON document_chunk USING gin(to_tsvector('simple', content))
      WHERE is_current AND approved_current;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_class index_row
      JOIN pg_index index_definition
        ON index_definition.indexrelid = index_row.oid
     WHERE index_row.relname = 'idx_chunk_content_trgm'
       AND coalesce(
         pg_get_expr(index_definition.indpred, index_definition.indrelid),
         ''
       ) LIKE '%approved_current%'
  ) THEN
    DROP INDEX IF EXISTS idx_chunk_content_trgm;
    CREATE INDEX idx_chunk_content_trgm
      ON document_chunk USING gin(content gin_trgm_ops)
      WHERE is_current AND approved_current;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_class index_row
      JOIN pg_index index_definition
        ON index_definition.indexrelid = index_row.oid
     WHERE index_row.relname = 'idx_chunk_document_page'
       AND coalesce(
         pg_get_expr(index_definition.indpred, index_definition.indrelid),
         ''
       ) LIKE '%approved_current%'
  ) THEN
    DROP INDEX IF EXISTS idx_chunk_document_page;
    CREATE INDEX idx_chunk_document_page
      ON document_chunk(document_id, page_start, chunk_index)
      WHERE is_current AND approved_current;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_class index_row
      JOIN pg_index index_definition
        ON index_definition.indexrelid = index_row.oid
     WHERE index_row.relname = 'idx_chunk_current_document'
       AND coalesce(
         pg_get_expr(index_definition.indpred, index_definition.indrelid),
         ''
       ) LIKE '%approved_current%'
  ) THEN
    DROP INDEX IF EXISTS idx_chunk_current_document;
    CREATE INDEX idx_chunk_current_document
      ON document_chunk(document_id, page_start)
      WHERE is_current AND approved_current;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_chunk_retention
  ON document_chunk(processing_version_key, stale_at, chunk_id)
  WHERE NOT is_current;
CREATE INDEX IF NOT EXISTS idx_document_page_retention
  ON document_page(extractor_version, stale_at, page_id)
  WHERE NOT is_current;
CREATE INDEX IF NOT EXISTS idx_document_processing_version_retention
  ON document_processing_version(version_key, stale_at, document_id);
CREATE INDEX IF NOT EXISTS idx_storage_maintenance_requested
  ON storage_maintenance_run(operation, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_storage_maintenance_token
  ON storage_maintenance_run(plan_token)
  WHERE plan_token IS NOT NULL;

COMMIT;
