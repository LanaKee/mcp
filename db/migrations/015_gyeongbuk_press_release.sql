-- 015_gyeongbuk_press_release.sql
-- Store 경상북도 press releases as narrative context.
--
-- Press releases are official *announcements*, not statistical observations.
-- They explain intent, budget plans and programme names in prose, which is the
-- context that statistical tables lack. They must never be usable as numeric
-- evidence, so this table is deliberately kept out of the fact/measure model and
-- is exposed only through narrative search.

CREATE TABLE IF NOT EXISTS press_release (
  press_release_id text PRIMARY KEY,
  region_id text REFERENCES dim_region(region_id),
  -- Regions merely *mentioned* in the headline or body. This is a keyword
  -- heuristic, not an assertion about which region the announcement governs.
  mentioned_region_ids text[] NOT NULL DEFAULT '{}',
  issuing_organization text NOT NULL,
  department text,
  contact_phone text,
  author text,
  title text NOT NULL,
  body text NOT NULL,
  body_sha256 char(64) NOT NULL,
  body_char_count integer NOT NULL CHECK (body_char_count >= 0),
  published_date date,
  published_at timestamptz,
  view_count integer CHECK (view_count IS NULL OR view_count >= 0),
  attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  detail_url text NOT NULL,
  -- Board-assigned identifier (B_STEP). Stable across re-crawls, which is why
  -- press_release_id is derived from it rather than from the source file.
  source_record_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  content_classification text NOT NULL CHECK (
    content_classification IN (
      'extracted_ok',
      'mojibake_suspected',
      'unusable_for_retrieval'
    )
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS press_release_published_date_idx
  ON press_release (published_date DESC);

CREATE INDEX IF NOT EXISTS press_release_department_idx
  ON press_release (department)
  WHERE department IS NOT NULL;

CREATE INDEX IF NOT EXISTS press_release_mentioned_regions_idx
  ON press_release USING gin (mentioned_region_ids);

CREATE INDEX IF NOT EXISTS press_release_title_fts_idx
  ON press_release USING gin (to_tsvector('simple', title));

CREATE INDEX IF NOT EXISTS press_release_body_fts_idx
  ON press_release USING gin (to_tsvector('simple', body))
  WHERE content_classification = 'extracted_ok';

CREATE INDEX IF NOT EXISTS press_release_title_trgm_idx
  ON press_release USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS press_release_source_idx
  ON press_release (source_id);

-- Re-crawls replace the row instead of accumulating duplicates, so the same
-- announcement collected from a newer snapshot keeps one identity.
CREATE UNIQUE INDEX IF NOT EXISTS press_release_source_record_idx
  ON press_release (source_record_id);
