BEGIN;

ALTER TABLE document
  ADD COLUMN IF NOT EXISTS document_key text,
  ADD COLUMN IF NOT EXISTS ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  ADD COLUMN IF NOT EXISTS extraction_status text,
  ADD COLUMN IF NOT EXISTS page_count integer,
  ADD COLUMN IF NOT EXISTS content_sha256 char(64);

UPDATE document
SET document_key = COALESCE(document_key, 'legacy-' || document_id::text),
    extraction_status = COALESCE(extraction_status, 'extracted'),
    page_count = COALESCE(page_count, 0),
    content_sha256 = COALESCE(
      content_sha256,
      encode(digest(COALESCE(metadata::text, document_id::text), 'sha256'), 'hex')
    )
WHERE document_key IS NULL
   OR extraction_status IS NULL
   OR page_count IS NULL
   OR content_sha256 IS NULL;

ALTER TABLE document
  ALTER COLUMN document_key SET NOT NULL,
  ALTER COLUMN extraction_status SET NOT NULL,
  ALTER COLUMN page_count SET NOT NULL,
  ALTER COLUMN content_sha256 SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_document_key_key'
  ) THEN
    ALTER TABLE document ADD CONSTRAINT document_document_key_key UNIQUE (document_key);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_extraction_status_check'
  ) THEN
    ALTER TABLE document ADD CONSTRAINT document_extraction_status_check CHECK (
      extraction_status IN (
        'extracted',
        'partial',
        'ocr_required',
        'extraction_failed',
        'password_required'
      )
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_page_count_check'
  ) THEN
    ALTER TABLE document ADD CONSTRAINT document_page_count_check CHECK (page_count >= 0);
  END IF;
END $$;

ALTER TABLE document_chunk
  ADD COLUMN IF NOT EXISTS chunk_key text,
  ADD COLUMN IF NOT EXISTS page_start integer,
  ADD COLUMN IF NOT EXISTS page_end integer,
  ADD COLUMN IF NOT EXISTS content_sha256 char(64),
  ADD COLUMN IF NOT EXISTS ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

UPDATE document_chunk
SET chunk_key = COALESCE(chunk_key, 'legacy-' || chunk_id::text),
    page_start = COALESCE(page_start, 1),
    page_end = COALESCE(page_end, page_start, 1),
    content_sha256 = COALESCE(
      content_sha256,
      encode(digest(content, 'sha256'), 'hex')
    )
WHERE chunk_key IS NULL
   OR page_start IS NULL
   OR page_end IS NULL
   OR content_sha256 IS NULL;

ALTER TABLE document_chunk
  ALTER COLUMN chunk_key SET NOT NULL,
  ALTER COLUMN page_start SET NOT NULL,
  ALTER COLUMN page_end SET NOT NULL,
  ALTER COLUMN content_sha256 SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_chunk_chunk_key_key'
  ) THEN
    ALTER TABLE document_chunk ADD CONSTRAINT document_chunk_chunk_key_key UNIQUE (chunk_key);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_chunk_page_start_check'
  ) THEN
    ALTER TABLE document_chunk ADD CONSTRAINT document_chunk_page_start_check CHECK (page_start > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_chunk_page_end_check'
  ) THEN
    ALTER TABLE document_chunk ADD CONSTRAINT document_chunk_page_end_check CHECK (page_end >= page_start);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS document_chunk_embedding (
  chunk_id uuid NOT NULL REFERENCES document_chunk(chunk_id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  model_version text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
  retrieval_mode text NOT NULL CHECK (retrieval_mode IN ('semantic', 'lexical_hash')),
  embedding real[] NOT NULL,
  content_sha256 char(64) NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (chunk_id, provider, model, model_version),
  CHECK (cardinality(embedding) = dimensions)
);

UPDATE document_chunk_embedding existing
SET model_version = '1-d' || existing.dimensions::text
WHERE existing.provider = 'local'
  AND existing.model = 'hashed-korean-token'
  AND existing.model_version = '1'
  AND NOT EXISTS (
    SELECT 1
    FROM document_chunk_embedding target
    WHERE target.chunk_id = existing.chunk_id
      AND target.provider = existing.provider
      AND target.model = existing.model
      AND target.model_version = '1-d' || existing.dimensions::text
  );

CREATE INDEX IF NOT EXISTS idx_chunk_content_trgm
  ON document_chunk USING gin(content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_document_source
  ON document(source_id);
CREATE INDEX IF NOT EXISTS idx_document_extraction_status
  ON document(extraction_status);
CREATE INDEX IF NOT EXISTS idx_document_title_trgm
  ON document USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_chunk_document_page
  ON document_chunk(document_id, page_start, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunk_current_document
  ON document_chunk(document_id, is_current);
CREATE INDEX IF NOT EXISTS idx_chunk_embedding_model
  ON document_chunk_embedding(provider, model, model_version, dimensions);

COMMIT;
