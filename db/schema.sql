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
  accounting_basis text NOT NULL CHECK (
    accounting_basis IN ('budget', 'settlement', 'reported')
  ),
  amount_semantics text NOT NULL DEFAULT 'legacy_unspecified' CHECK (
    amount_semantics IN (
      'legacy_unspecified',
      'collected_amount',
      'payment_amount',
      'reported_total_tax_burden',
      'demo_settlement'
    )
  ),
  source_grain text NOT NULL DEFAULT 'legacy_unspecified' CHECK (
    source_grain IN (
      'legacy_unspecified',
      'collection_status',
      'statistical_yearbook_local_collection',
      'payment_media',
      'per_capita_burden',
      'demo_sample'
    )
  ),
  unit_original text NOT NULL DEFAULT 'KRW' CHECK (
    unit_original IN ('KRW', 'thousand_KRW')
  ),
  unit_multiplier integer NOT NULL DEFAULT 1 CHECK (unit_multiplier IN (1, 1000)),
  unit_provenance text NOT NULL DEFAULT 'legacy_unspecified' CHECK (
    unit_provenance IN (
      'legacy_unspecified',
      'explicit_header_krw',
      'explicit_header_thousand_krw',
      'unmarked_header_default_krw',
      'cross_source_reconciliation_thousand_krw',
      'demo_declared_krw'
    )
  ),
  is_aggregate boolean NOT NULL DEFAULT false,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  source_row integer,
  data_status text NOT NULL CHECK (data_status IN ('official_observed', 'demo_sample')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (region_id, fiscal_year, tax_category, accounting_basis, source_id)
);

CREATE TABLE IF NOT EXISTS local_tax_collection_status (
  collection_status_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id text NOT NULL REFERENCES dim_region(region_id),
  fiscal_year smallint NOT NULL,
  tax_category text NOT NULL,
  assessed_amount_won bigint NOT NULL CHECK (assessed_amount_won >= 0),
  collected_amount_won bigint NOT NULL CHECK (collected_amount_won >= 0),
  refunded_amount_won bigint CHECK (refunded_amount_won IS NULL OR refunded_amount_won >= 0),
  written_off_amount_won bigint CHECK (written_off_amount_won IS NULL OR written_off_amount_won >= 0),
  uncollected_amount_won bigint CHECK (uncollected_amount_won IS NULL OR uncollected_amount_won >= 0),
  reported_collection_rate numeric(9,4),
  computed_collection_rate numeric(9,4),
  unit_original text NOT NULL,
  unit_multiplier integer NOT NULL CHECK (unit_multiplier IN (1, 1000)),
  unit_provenance text NOT NULL,
  is_aggregate boolean NOT NULL DEFAULT false,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, source_row)
);

CREATE TABLE IF NOT EXISTS local_tax_payment_media (
  payment_media_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id text NOT NULL REFERENCES dim_region(region_id),
  fiscal_year smallint NOT NULL,
  tax_category text NOT NULL,
  payment_method text,
  electronic_notice boolean,
  payment_count integer NOT NULL CHECK (payment_count >= 0),
  payment_amount_won bigint NOT NULL CHECK (payment_amount_won >= 0),
  reported_media_share numeric(12,6),
  unit_original text NOT NULL,
  unit_multiplier integer NOT NULL CHECK (unit_multiplier IN (1, 1000)),
  unit_provenance text NOT NULL,
  is_aggregate boolean NOT NULL DEFAULT false,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, source_row)
);

CREATE TABLE IF NOT EXISTS local_tax_assessment_status (
  assessment_status_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id text NOT NULL REFERENCES dim_region(region_id),
  fiscal_year smallint NOT NULL,
  tax_category text NOT NULL,
  assessed_count integer CHECK (assessed_count IS NULL OR assessed_count >= 0),
  assessed_amount_won bigint CHECK (assessed_amount_won IS NULL OR assessed_amount_won >= 0),
  non_taxable_count integer CHECK (non_taxable_count IS NULL OR non_taxable_count >= 0),
  non_taxable_amount_won bigint CHECK (non_taxable_amount_won IS NULL OR non_taxable_amount_won >= 0),
  unit_original text NOT NULL,
  unit_multiplier integer NOT NULL CHECK (unit_multiplier IN (1, 1000)),
  unit_provenance text NOT NULL,
  is_aggregate boolean NOT NULL DEFAULT false,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, source_row)
);

CREATE TABLE IF NOT EXISTS local_tax_per_capita_burden (
  per_capita_burden_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id text NOT NULL REFERENCES dim_region(region_id),
  fiscal_year smallint NOT NULL,
  per_resident_amount_won bigint NOT NULL CHECK (per_resident_amount_won >= 0),
  per_household_amount_won bigint NOT NULL CHECK (per_household_amount_won >= 0),
  total_local_tax_amount_won bigint NOT NULL CHECK (total_local_tax_amount_won >= 0),
  population_count integer CHECK (population_count IS NULL OR population_count >= 0),
  household_count integer CHECK (household_count IS NULL OR household_count >= 0),
  unit_original text NOT NULL,
  unit_multiplier integer NOT NULL CHECK (unit_multiplier IN (1, 1000)),
  unit_provenance text NOT NULL,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, source_row)
);

CREATE TABLE IF NOT EXISTS local_tax_taxpayer_status (
  taxpayer_status_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id text NOT NULL REFERENCES dim_region(region_id),
  fiscal_year smallint NOT NULL,
  tax_category text NOT NULL,
  taxpayer_type text NOT NULL,
  jurisdiction_scope text NOT NULL,
  taxpayer_count integer NOT NULL CHECK (taxpayer_count >= 0),
  is_aggregate boolean NOT NULL DEFAULT false,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, source_row)
);

CREATE TABLE IF NOT EXISTS local_tax_exemption_status (
  exemption_status_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id text NOT NULL REFERENCES dim_region(region_id),
  fiscal_year smallint NOT NULL,
  tax_category text NOT NULL,
  non_taxable_amount_won bigint NOT NULL CHECK (non_taxable_amount_won >= 0),
  reduction_amount_won bigint NOT NULL CHECK (reduction_amount_won >= 0),
  assessed_amount_won bigint NOT NULL CHECK (assessed_amount_won >= 0),
  reported_exemption_rate numeric(12,6),
  computed_exemption_rate numeric(12,6),
  unit_original text NOT NULL,
  unit_multiplier integer NOT NULL CHECK (unit_multiplier IN (1, 1000)),
  unit_provenance text NOT NULL,
  is_aggregate boolean NOT NULL DEFAULT false,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, source_row)
);

CREATE TABLE IF NOT EXISTS local_tax_unrefunded_status (
  unrefunded_status_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id text NOT NULL REFERENCES dim_region(region_id),
  fiscal_year smallint NOT NULL,
  tax_category text NOT NULL,
  unrefunded_type text NOT NULL,
  taxpayer_type text NOT NULL,
  current_count integer NOT NULL CHECK (current_count >= 0),
  current_amount_won bigint NOT NULL CHECK (current_amount_won >= 0),
  cumulative_count integer NOT NULL CHECK (cumulative_count >= 0),
  cumulative_amount_won bigint NOT NULL CHECK (cumulative_amount_won >= 0),
  reported_cumulative_change numeric(18,6),
  unit_original text NOT NULL,
  unit_multiplier integer NOT NULL CHECK (unit_multiplier IN (1, 1000)),
  unit_provenance text NOT NULL,
  is_aggregate boolean NOT NULL DEFAULT false,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, source_row)
);

CREATE TABLE IF NOT EXISTS local_tax_enforcement_statistic (
  enforcement_statistic_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id text NOT NULL REFERENCES dim_region(region_id),
  fiscal_year smallint NOT NULL,
  enforcement_date date NOT NULL,
  agency text NOT NULL,
  delinquency_count integer NOT NULL CHECK (delinquency_count >= 0),
  delinquency_amount_won bigint NOT NULL CHECK (delinquency_amount_won >= 0),
  unit_original text NOT NULL,
  unit_multiplier integer NOT NULL CHECK (unit_multiplier IN (1, 1000)),
  unit_provenance text NOT NULL,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  source_row integer NOT NULL CHECK (source_row > 0),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, source_row)
);

CREATE TABLE IF NOT EXISTS data_quality_issue (
  issue_key text PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  issue_code text NOT NULL,
  entity_type text NOT NULL,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  source_row integer,
  field_name text,
  message text NOT NULL,
  observed jsonb,
  expected jsonb,
  quarantined boolean NOT NULL DEFAULT false,
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
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
  processing_version_key text NOT NULL REFERENCES pdf_processing_version(version_key),
  is_current boolean NOT NULL DEFAULT true,
  approved_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  stale_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

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
  created_at timestamptz NOT NULL DEFAULT now(),
  stale_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

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
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, entity_type, entity_key)
);

CREATE TABLE IF NOT EXISTS mcp_tool_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool_name text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  success boolean NOT NULL,
  data_statuses text[] NOT NULL DEFAULT '{}',
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  request_hash char(64) NOT NULL,
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id varchar(64)
    CONSTRAINT mcp_tool_audit_correlation_format
    CHECK (
      correlation_id IS NULL
      OR correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$'
    ),
  error_class text,
  repository_mode text NOT NULL CHECK (repository_mode IN ('memory', 'postgres')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  CHECK (
    data_statuses <@ ARRAY[
      'official_observed',
      'demo_sample',
      'catalog_only',
      'mixed'
    ]::text[]
  )
);

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

CREATE INDEX IF NOT EXISTS idx_population_region_year
  ON population_observation(region_id, year);
CREATE INDEX IF NOT EXISTS idx_tax_region_year
  ON local_tax_revenue(region_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_local_tax_revenue_precedence
  ON local_tax_revenue(region_id, fiscal_year, tax_category, data_status, source_grain);
CREATE INDEX IF NOT EXISTS idx_tax_collection_region_year
  ON local_tax_collection_status(region_id, fiscal_year, tax_category);
CREATE INDEX IF NOT EXISTS idx_tax_payment_region_year
  ON local_tax_payment_media(region_id, fiscal_year, tax_category);
CREATE INDEX IF NOT EXISTS idx_tax_assessment_region_year
  ON local_tax_assessment_status(region_id, fiscal_year, tax_category);
CREATE INDEX IF NOT EXISTS idx_tax_burden_region_year
  ON local_tax_per_capita_burden(region_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_taxpayer_region_year
  ON local_tax_taxpayer_status(region_id, fiscal_year, tax_category);
CREATE INDEX IF NOT EXISTS idx_tax_exemption_region_year
  ON local_tax_exemption_status(region_id, fiscal_year, tax_category);
CREATE INDEX IF NOT EXISTS idx_tax_unrefunded_region_year
  ON local_tax_unrefunded_status(region_id, fiscal_year, tax_category);
CREATE INDEX IF NOT EXISTS idx_tax_enforcement_region_date
  ON local_tax_enforcement_statistic(region_id, enforcement_date);
CREATE INDEX IF NOT EXISTS idx_data_quality_issue_source
  ON data_quality_issue(source_id, severity, issue_code);
CREATE INDEX IF NOT EXISTS idx_data_quality_issue_quarantine
  ON data_quality_issue(quarantined, severity)
  WHERE quarantined;
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
CREATE INDEX IF NOT EXISTS idx_council_title_fts
  ON council_record USING gin(to_tsvector('simple', title));
CREATE INDEX IF NOT EXISTS idx_chunk_fts
  ON document_chunk USING gin(to_tsvector('simple', content))
  WHERE is_current AND approved_current;
CREATE INDEX IF NOT EXISTS idx_chunk_content_trgm
  ON document_chunk USING gin(content gin_trgm_ops)
  WHERE is_current AND approved_current;
CREATE INDEX IF NOT EXISTS idx_document_source
  ON document(source_id);
CREATE INDEX IF NOT EXISTS idx_document_extraction_status
  ON document(extraction_status);
CREATE INDEX IF NOT EXISTS idx_document_title_trgm
  ON document USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_chunk_document_page
  ON document_chunk(document_id, page_start, chunk_index)
  WHERE is_current AND approved_current;
CREATE INDEX IF NOT EXISTS idx_chunk_current_document
  ON document_chunk(document_id, page_start)
  WHERE is_current AND approved_current;
CREATE INDEX IF NOT EXISTS idx_chunk_retention
  ON document_chunk(processing_version_key, stale_at, chunk_id)
  WHERE NOT is_current;
CREATE INDEX IF NOT EXISTS idx_document_page_document
  ON document_page(document_id, page_number);
CREATE INDEX IF NOT EXISTS idx_document_page_quality
  ON document_page(text_class, extraction_status)
  WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_page_current
  ON document_page(document_id, page_number)
  WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_document_page_retention
  ON document_page(extractor_version, stale_at, page_id)
  WHERE NOT is_current;
CREATE INDEX IF NOT EXISTS idx_document_processing_version_retention
  ON document_processing_version(version_key, stale_at, document_id);
CREATE INDEX IF NOT EXISTS idx_chunk_embedding_model
  ON document_chunk_embedding(provider, model, model_version, dimensions);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_processing_one_approved
  ON pdf_processing_version((approval_state))
  WHERE approval_state = 'approved';
CREATE INDEX IF NOT EXISTS idx_pdf_processing_state
  ON pdf_processing_version(approval_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pdf_processing_event
  ON pdf_processing_version_event(version_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_storage_maintenance_requested
  ON storage_maintenance_run(operation, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_storage_maintenance_token
  ON storage_maintenance_run(plan_token)
  WHERE plan_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_created
  ON mcp_tool_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_tool_time
  ON mcp_tool_audit(tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_expires
  ON mcp_tool_audit(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_correlation
  ON mcp_tool_audit(correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_source_sha
  ON data_source(file_sha256);
