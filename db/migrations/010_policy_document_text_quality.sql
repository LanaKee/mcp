BEGIN;

ALTER TABLE document
  ADD COLUMN IF NOT EXISTS content_classification text,
  ADD COLUMN IF NOT EXISTS extraction_method text,
  DROP CONSTRAINT IF EXISTS document_extraction_status_check,
  DROP CONSTRAINT IF EXISTS document_content_classification_check,
  DROP CONSTRAINT IF EXISTS document_extraction_method_check;

UPDATE document
SET content_classification = CASE
      WHEN extraction_status = 'ocr_required' THEN 'unusable_for_retrieval'
      WHEN extraction_status IN ('extraction_failed', 'password_required') THEN 'empty'
      ELSE 'extracted_ok'
    END,
    extraction_method = CASE
      WHEN extraction_status IN ('extracted', 'partial') THEN 'native_pdf_text'
      ELSE 'none'
    END
WHERE content_classification IS NULL OR extraction_method IS NULL;

UPDATE document
SET content_classification = 'unusable_for_retrieval',
    extraction_status = 'unusable_for_retrieval',
    extraction_method = 'none'
WHERE content_classification = 'ocr_required'
   OR extraction_status = 'ocr_required';

ALTER TABLE document
  ALTER COLUMN content_classification SET DEFAULT 'extracted_ok',
  ALTER COLUMN content_classification SET NOT NULL,
  ALTER COLUMN extraction_method SET DEFAULT 'native_pdf_text',
  ALTER COLUMN extraction_method SET NOT NULL,
  DROP CONSTRAINT IF EXISTS document_content_classification_check,
  ADD CONSTRAINT document_content_classification_check CHECK (
    content_classification IN (
      'extracted_ok',
      'mojibake_suspected',
      'unusable_for_retrieval',
      'empty'
    )
  ),
  DROP CONSTRAINT IF EXISTS document_extraction_method_check,
  ADD CONSTRAINT document_extraction_method_check CHECK (
    extraction_method IN ('native_pdf_text', 'none')
  ),
  ADD CONSTRAINT document_extraction_status_check CHECK (
    extraction_status IN (
      'extracted',
      'partial',
      'unusable_for_retrieval',
      'extraction_failed',
      'password_required'
    )
  );

ALTER TABLE document_processing_version
  ADD COLUMN IF NOT EXISTS content_classification text,
  ADD COLUMN IF NOT EXISTS extraction_method text,
  DROP CONSTRAINT IF EXISTS document_processing_version_extraction_status_check,
  DROP CONSTRAINT IF EXISTS document_processing_version_content_classification_check,
  DROP CONSTRAINT IF EXISTS document_processing_version_extraction_method_check;

UPDATE document_processing_version version
SET content_classification = document_row.content_classification,
    extraction_method = document_row.extraction_method
FROM document document_row
WHERE version.document_id = document_row.document_id
  AND (
    version.content_classification IS NULL OR
    version.extraction_method IS NULL
  );

UPDATE document_processing_version
SET content_classification = 'unusable_for_retrieval',
    extraction_status = 'unusable_for_retrieval',
    extraction_method = 'none'
WHERE content_classification = 'ocr_required'
   OR extraction_status = 'ocr_required';

ALTER TABLE document_processing_version
  ALTER COLUMN content_classification SET DEFAULT 'extracted_ok',
  ALTER COLUMN content_classification SET NOT NULL,
  ALTER COLUMN extraction_method SET DEFAULT 'native_pdf_text',
  ALTER COLUMN extraction_method SET NOT NULL,
  DROP CONSTRAINT IF EXISTS document_processing_version_content_classification_check,
  ADD CONSTRAINT document_processing_version_content_classification_check CHECK (
    content_classification IN (
      'extracted_ok',
      'mojibake_suspected',
      'unusable_for_retrieval',
      'empty'
    )
  ),
  DROP CONSTRAINT IF EXISTS document_processing_version_extraction_method_check,
  ADD CONSTRAINT document_processing_version_extraction_method_check CHECK (
    extraction_method IN ('native_pdf_text', 'none')
  ),
  ADD CONSTRAINT document_processing_version_extraction_status_check CHECK (
    extraction_status IN (
      'extracted',
      'partial',
      'unusable_for_retrieval',
      'extraction_failed',
      'password_required'
    )
  );

ALTER TABLE document_page
  ADD COLUMN IF NOT EXISTS content_classification text,
  ADD COLUMN IF NOT EXISTS extraction_method text,
  ADD COLUMN IF NOT EXISTS hangul_character_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS administrative_term_hit_rate real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS valid_hangul_bigram_ratio real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rare_hangul_syllable_ratio real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS particle_ratio real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whitespace_boundary_ratio real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS digit_punctuation_ratio real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mojibake_score real NOT NULL DEFAULT 0,
  DROP CONSTRAINT IF EXISTS document_page_extraction_status_check,
  DROP CONSTRAINT IF EXISTS document_page_content_classification_check,
  DROP CONSTRAINT IF EXISTS document_page_extraction_method_check;

UPDATE document_page
SET content_classification = CASE
      WHEN extraction_status = 'ocr_required' THEN 'unusable_for_retrieval'
      WHEN extraction_status = 'extraction_failed' THEN 'empty'
      ELSE 'extracted_ok'
    END,
    extraction_method = CASE
      WHEN extraction_status = 'extracted' THEN 'native_pdf_text'
      ELSE 'none'
    END
WHERE content_classification IS NULL OR extraction_method IS NULL;

UPDATE document_page
SET content_classification = 'unusable_for_retrieval',
    extraction_status = 'unusable_for_retrieval',
    extraction_method = 'none'
WHERE content_classification = 'ocr_required'
   OR extraction_status = 'ocr_required';

ALTER TABLE document_page
  ALTER COLUMN content_classification SET DEFAULT 'extracted_ok',
  ALTER COLUMN content_classification SET NOT NULL,
  ALTER COLUMN extraction_method SET DEFAULT 'native_pdf_text',
  ALTER COLUMN extraction_method SET NOT NULL,
  ADD CONSTRAINT document_page_extraction_status_check CHECK (
    extraction_status IN (
      'extracted',
      'unusable_for_retrieval',
      'empty',
      'extraction_failed'
    )
  ),
  DROP CONSTRAINT IF EXISTS document_page_content_classification_check,
  ADD CONSTRAINT document_page_content_classification_check CHECK (
    content_classification IN (
      'extracted_ok',
      'mojibake_suspected',
      'unusable_for_retrieval',
      'empty'
    )
  ),
  DROP CONSTRAINT IF EXISTS document_page_extraction_method_check,
  ADD CONSTRAINT document_page_extraction_method_check CHECK (
    extraction_method IN ('native_pdf_text', 'none')
  ),
  DROP CONSTRAINT IF EXISTS document_page_hangul_character_count_check,
  ADD CONSTRAINT document_page_hangul_character_count_check CHECK (
    hangul_character_count >= 0
  ),
  DROP CONSTRAINT IF EXISTS document_page_administrative_term_hit_rate_check,
  ADD CONSTRAINT document_page_administrative_term_hit_rate_check CHECK (
    administrative_term_hit_rate BETWEEN 0 AND 1
  ),
  DROP CONSTRAINT IF EXISTS document_page_valid_hangul_bigram_ratio_check,
  ADD CONSTRAINT document_page_valid_hangul_bigram_ratio_check CHECK (
    valid_hangul_bigram_ratio BETWEEN 0 AND 1
  ),
  DROP CONSTRAINT IF EXISTS document_page_rare_hangul_syllable_ratio_check,
  ADD CONSTRAINT document_page_rare_hangul_syllable_ratio_check CHECK (
    rare_hangul_syllable_ratio BETWEEN 0 AND 1
  ),
  DROP CONSTRAINT IF EXISTS document_page_particle_ratio_check,
  ADD CONSTRAINT document_page_particle_ratio_check CHECK (
    particle_ratio BETWEEN 0 AND 1
  ),
  DROP CONSTRAINT IF EXISTS document_page_whitespace_boundary_ratio_check,
  ADD CONSTRAINT document_page_whitespace_boundary_ratio_check CHECK (
    whitespace_boundary_ratio BETWEEN 0 AND 1
  ),
  DROP CONSTRAINT IF EXISTS document_page_digit_punctuation_ratio_check,
  ADD CONSTRAINT document_page_digit_punctuation_ratio_check CHECK (
    digit_punctuation_ratio BETWEEN 0 AND 1
  ),
  DROP CONSTRAINT IF EXISTS document_page_mojibake_score_check,
  ADD CONSTRAINT document_page_mojibake_score_check CHECK (
    mojibake_score BETWEEN 0 AND 1
  );

CREATE INDEX IF NOT EXISTS idx_document_content_classification
  ON document(content_classification, document_type);
CREATE INDEX IF NOT EXISTS idx_document_page_content_classification
  ON document_page(content_classification, extraction_method)
  WHERE is_current;
DROP TABLE IF EXISTS document_ocr_queue;

COMMIT;
