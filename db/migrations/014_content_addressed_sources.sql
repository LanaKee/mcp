-- Content-address official data sources.
--
-- Source keys used to embed the file path (`official:<path>:<sha>`), so the same
-- bytes stored at two paths became two sources. Because every fact table is keyed
-- by (source_id, source_row), that silently duplicated the facts themselves.
-- Identity now follows the digest, matching the intake store's dedupe rule.

BEGIN;

CREATE TEMP TABLE duplicate_official_source ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    source_id,
    file_sha256,
    row_number() OVER (
      PARTITION BY file_sha256
      ORDER BY file_path, source_id
    ) AS duplicate_rank
  FROM data_source
  WHERE file_sha256 IS NOT NULL
    AND source_key LIKE 'official:%'
)
SELECT source_id
  FROM ranked
 WHERE duplicate_rank > 1;

-- The document graph hangs off the source, so it unwinds first.
DELETE FROM document_chunk_embedding
WHERE chunk_id IN (
  SELECT chunk.chunk_id
    FROM document_chunk chunk
    JOIN document doc ON doc.document_id = chunk.document_id
   WHERE doc.source_id IN (SELECT source_id FROM duplicate_official_source)
);

DELETE FROM document_chunk
WHERE document_id IN (
  SELECT document_id FROM document
   WHERE source_id IN (SELECT source_id FROM duplicate_official_source)
);

DELETE FROM document_page
WHERE document_id IN (
  SELECT document_id FROM document
   WHERE source_id IN (SELECT source_id FROM duplicate_official_source)
);

DELETE FROM document_processing_version
WHERE document_id IN (
  SELECT document_id FROM document
   WHERE source_id IN (SELECT source_id FROM duplicate_official_source)
);

DELETE FROM document
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM source_locator
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM council_record
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM population_observation
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM policy_program
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM data_quality_issue
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM local_tax_revenue
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM local_tax_collection_status
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM local_tax_payment_media
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM local_tax_assessment_status
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM local_tax_per_capita_burden
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM local_tax_taxpayer_status
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM local_tax_exemption_status
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM local_tax_unrefunded_status
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM local_tax_enforcement_statistic
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

DELETE FROM data_source
WHERE source_id IN (SELECT source_id FROM duplicate_official_source);

UPDATE data_source
   SET source_key = 'official:' || file_sha256
 WHERE file_sha256 IS NOT NULL
   AND source_key LIKE 'official:%'
   AND source_key <> 'official:' || file_sha256;

COMMIT;
