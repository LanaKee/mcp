BEGIN;

ALTER TABLE document_chunk
  DROP CONSTRAINT IF EXISTS document_chunk_document_id_chunk_index_key;

CREATE TABLE IF NOT EXISTS document_page (
  page_id uuid PRIMARY KEY,
  page_key text NOT NULL UNIQUE,
  document_id uuid NOT NULL REFERENCES document(document_id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number > 0),
  extraction_status text NOT NULL CHECK (
    extraction_status IN ('extracted', 'ocr_required', 'extraction_failed')
  ),
  raw_content_sha256 char(64) NOT NULL,
  content_sha256 char(64) NOT NULL,
  extractor_version text NOT NULL,
  non_whitespace_character_count integer NOT NULL CHECK (non_whitespace_character_count >= 0),
  hangul_ratio real NOT NULL CHECK (hangul_ratio BETWEEN 0 AND 1),
  replacement_control_glyph_ratio real NOT NULL CHECK (replacement_control_glyph_ratio BETWEEN 0 AND 1),
  suspicious_spacing_ratio real NOT NULL CHECK (suspicious_spacing_ratio BETWEEN 0 AND 1),
  repeated_header_line_count integer NOT NULL DEFAULT 0 CHECK (repeated_header_line_count >= 0),
  repeated_footer_line_count integer NOT NULL DEFAULT 0 CHECK (repeated_footer_line_count >= 0),
  likely_table_line_count integer NOT NULL DEFAULT 0 CHECK (likely_table_line_count >= 0),
  likely_table_density real NOT NULL CHECK (likely_table_density BETWEEN 0 AND 1),
  speaker_marker_count integer NOT NULL DEFAULT 0 CHECK (speaker_marker_count >= 0),
  text_class text NOT NULL CHECK (text_class IN ('empty', 'near_empty', 'substantive')),
  error_text text,
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  is_current boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_document_page_document
  ON document_page(document_id, page_number);
CREATE INDEX IF NOT EXISTS idx_document_page_quality
  ON document_page(text_class, extraction_status)
  WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_page_current
  ON document_page(document_id, page_number)
  WHERE is_current;

COMMIT;
