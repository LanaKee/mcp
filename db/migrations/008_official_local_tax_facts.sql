BEGIN;

ALTER TABLE local_tax_revenue
  ADD COLUMN IF NOT EXISTS amount_semantics text NOT NULL DEFAULT 'legacy_unspecified',
  ADD COLUMN IF NOT EXISTS source_grain text NOT NULL DEFAULT 'legacy_unspecified',
  ADD COLUMN IF NOT EXISTS unit_original text NOT NULL DEFAULT 'KRW',
  ADD COLUMN IF NOT EXISTS unit_multiplier integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS unit_provenance text NOT NULL DEFAULT 'legacy_unspecified',
  ADD COLUMN IF NOT EXISTS is_aggregate boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_row integer,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'local_tax_revenue_accounting_basis_check'
  ) THEN
    ALTER TABLE local_tax_revenue
      DROP CONSTRAINT local_tax_revenue_accounting_basis_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'local_tax_revenue_accounting_basis_v2_check'
  ) THEN
    ALTER TABLE local_tax_revenue
      ADD CONSTRAINT local_tax_revenue_accounting_basis_v2_check
      CHECK (accounting_basis IN ('budget', 'settlement', 'reported'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'local_tax_revenue_unit_multiplier_check'
  ) THEN
    ALTER TABLE local_tax_revenue
      ADD CONSTRAINT local_tax_revenue_unit_multiplier_check
      CHECK (unit_multiplier IN (1, 1000));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'local_tax_revenue_amount_semantics_check'
  ) THEN
    ALTER TABLE local_tax_revenue
      ADD CONSTRAINT local_tax_revenue_amount_semantics_check
      CHECK (amount_semantics IN (
        'legacy_unspecified',
        'collected_amount',
        'payment_amount',
        'reported_total_tax_burden',
        'demo_settlement'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'local_tax_revenue_source_grain_check'
  ) THEN
    ALTER TABLE local_tax_revenue
      ADD CONSTRAINT local_tax_revenue_source_grain_check
      CHECK (source_grain IN (
        'legacy_unspecified',
        'collection_status',
        'payment_media',
        'per_capita_burden',
        'demo_sample'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'local_tax_revenue_unit_original_check'
  ) THEN
    ALTER TABLE local_tax_revenue
      ADD CONSTRAINT local_tax_revenue_unit_original_check
      CHECK (unit_original IN ('KRW', 'thousand_KRW'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'local_tax_revenue_unit_provenance_check'
  ) THEN
    ALTER TABLE local_tax_revenue
      ADD CONSTRAINT local_tax_revenue_unit_provenance_check
      CHECK (unit_provenance IN (
        'legacy_unspecified',
        'explicit_header_krw',
        'explicit_header_thousand_krw',
        'unmarked_header_default_krw',
        'cross_source_reconciliation_thousand_krw',
        'demo_declared_krw'
      ));
  END IF;
END $$;

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

COMMIT;
