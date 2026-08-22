ALTER TABLE population_observation
  ADD COLUMN IF NOT EXISTS measurement_basis text;

ALTER TABLE population_observation
  ADD COLUMN IF NOT EXISTS reference_date_precision text;

ALTER TABLE population_observation
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE population_observation
SET measurement_basis = CASE
  WHEN data_status = 'demo_sample' THEN 'demo_annual_population'
  ELSE 'resident_registration_snapshot'
END
WHERE measurement_basis IS NULL;

UPDATE population_observation
SET reference_date_precision = CASE
  WHEN data_status = 'demo_sample' THEN 'year'
  ELSE 'month'
END
WHERE reference_date_precision IS NULL;

ALTER TABLE population_observation
  ALTER COLUMN measurement_basis SET NOT NULL,
  ALTER COLUMN reference_date_precision SET NOT NULL;

ALTER TABLE population_observation
  DROP CONSTRAINT IF EXISTS population_observation_measurement_basis_check;

ALTER TABLE population_observation
  ADD CONSTRAINT population_observation_measurement_basis_check CHECK (
    measurement_basis IN (
      'resident_registration_snapshot',
      'tax_year_reported_population',
      'annual_statistical_population',
      'demo_annual_population'
    )
  );

ALTER TABLE population_observation
  DROP CONSTRAINT IF EXISTS population_observation_reference_date_precision_check;

ALTER TABLE population_observation
  ADD CONSTRAINT population_observation_reference_date_precision_check CHECK (
    reference_date_precision IN ('day', 'month', 'year')
  );
