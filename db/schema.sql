CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS dim_region (
  region_id text PRIMARY KEY,
  region_name text NOT NULL,
  region_type text NOT NULL CHECK (region_type IN ('province', 'city', 'county', 'district', 'town')),
  parent_region_id text REFERENCES dim_region(region_id),
  normalized_name text NOT NULL,
  valid_from date,
  valid_to date,
  UNIQUE (parent_region_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS data_source (
  source_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  title text NOT NULL,
  provider text NOT NULL,
  source_url text,
  license_note text,
  file_path text,
  file_sha256 char(64),
  collected_at timestamptz NOT NULL,
  reference_date date,
  media_type text NOT NULL,
  data_status text NOT NULL CHECK (data_status IN ('official_observed', 'demo_sample', 'catalog_only')),
  is_official boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS ingestion_run (
  ingestion_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_name text NOT NULL,
  pipeline_version text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  input_sha256 char(64),
  inserted_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  error_report jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS population_observation (
  population_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id text NOT NULL REFERENCES dim_region(region_id),
  reference_date date NOT NULL,
  year smallint GENERATED ALWAYS AS (EXTRACT(YEAR FROM reference_date)::smallint) STORED,
  population_total integer NOT NULL CHECK (population_total >= 0),
  population_male integer CHECK (population_male >= 0),
  population_female integer CHECK (population_female >= 0),
  household_count integer CHECK (household_count >= 0),
  foreign_population integer CHECK (foreign_population >= 0),
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  source_row integer,
  data_status text NOT NULL CHECK (data_status IN ('official_observed', 'demo_sample')),
  UNIQUE (region_id, reference_date, source_id)
);

CREATE TABLE IF NOT EXISTS local_tax_revenue (
  local_tax_revenue_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id text NOT NULL REFERENCES dim_region(region_id),
  fiscal_year smallint NOT NULL,
  tax_category text NOT NULL,
  revenue_amount_won bigint NOT NULL CHECK (revenue_amount_won >= 0),
  accounting_basis text NOT NULL CHECK (accounting_basis IN ('budget', 'settlement')),
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status IN ('official_observed', 'demo_sample')),
  UNIQUE (region_id, fiscal_year, tax_category, accounting_basis, source_id)
);

CREATE TABLE IF NOT EXISTS policy_program (
  policy_id text PRIMARY KEY,
  region_id text REFERENCES dim_region(region_id),
  title text NOT NULL,
  managing_organization text NOT NULL,
  target_age_min smallint,
  target_age_max smallint,
  industries text[] NOT NULL DEFAULT '{}',
  stages text[] NOT NULL DEFAULT '{}',
  eligibility_text text NOT NULL,
  support_text text NOT NULL,
  application_start date,
  application_end date,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status IN ('official_observed', 'demo_sample')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (target_age_min IS NULL OR target_age_max IS NULL OR target_age_min <= target_age_max)
);

CREATE TABLE IF NOT EXISTS council_record (
  council_record_id text PRIMARY KEY,
  region_id text REFERENCES dim_region(region_id),
  council_name text NOT NULL,
  session_name text,
  meeting_date date,
  agenda_number text,
  title text NOT NULL,
  proposer text,
  resolution text,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status IN ('official_observed', 'demo_sample')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS document (
  document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_key text NOT NULL UNIQUE,
  region_id text REFERENCES dim_region(region_id),
  document_type text NOT NULL,
  title text NOT NULL,
  organization text,
  published_date date,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
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
  data_status text NOT NULL CHECK (data_status IN ('official_observed', 'demo_sample', 'catalog_only')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS document_chunk (
  chunk_id uuid PRIMARY KEY,
  chunk_key text NOT NULL UNIQUE,
  document_id uuid NOT NULL REFERENCES document(document_id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  page_start integer NOT NULL CHECK (page_start > 0),
  page_end integer NOT NULL CHECK (page_end >= page_start),
  section_title text,
  content text NOT NULL,
  content_sha256 char(64) NOT NULL,
  token_count integer CHECK (token_count IS NULL OR token_count >= 0),
  embedding_model text,
  embedding_dimensions integer,
  embedding_data jsonb,
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  is_current boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (document_id, chunk_index)
);

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

CREATE TABLE IF NOT EXISTS source_locator (
  source_locator_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES data_source(source_id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  page_number integer,
  row_number integer,
  section_name text,
  character_start integer,
  character_end integer,
  locator_text text,
  UNIQUE (source_id, entity_type, entity_key)
);

CREATE INDEX IF NOT EXISTS idx_population_region_year
  ON population_observation(region_id, year);
CREATE INDEX IF NOT EXISTS idx_tax_region_year
  ON local_tax_revenue(region_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_policy_region_age
  ON policy_program(region_id, target_age_min, target_age_max);
CREATE INDEX IF NOT EXISTS idx_policy_industries
  ON policy_program USING gin(industries);
CREATE INDEX IF NOT EXISTS idx_policy_ingestion_run
  ON policy_program(ingestion_run_id);
CREATE INDEX IF NOT EXISTS idx_council_date_region
  ON council_record(meeting_date, region_id);
CREATE INDEX IF NOT EXISTS idx_council_ingestion_run
  ON council_record(ingestion_run_id);
CREATE INDEX IF NOT EXISTS idx_council_title_trgm
  ON council_record USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_chunk_fts
  ON document_chunk USING gin(to_tsvector('simple', content));
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
CREATE INDEX IF NOT EXISTS idx_source_sha
  ON data_source(file_sha256);
