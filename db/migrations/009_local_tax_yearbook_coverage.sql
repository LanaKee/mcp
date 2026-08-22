BEGIN;

ALTER TABLE local_tax_revenue
  DROP CONSTRAINT IF EXISTS local_tax_revenue_source_grain_check;

ALTER TABLE local_tax_revenue
  ADD CONSTRAINT local_tax_revenue_source_grain_check
  CHECK (source_grain IN (
    'legacy_unspecified',
    'collection_status',
    'statistical_yearbook_local_collection',
    'payment_media',
    'per_capita_burden',
    'demo_sample'
  ));

COMMIT;
