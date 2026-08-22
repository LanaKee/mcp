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

-- document_key is derived from source_key (`document-<sha256(source_key)[:48]>`),
-- so rewriting a source key strands its document graph: the PDF stage no longer
-- recognises the existing rows and inserts a second copy of every page, chunk
-- and embedding. Re-key the documents instead of dropping them, so superseded
-- processing versions retained by the lifecycle policy survive the migration.
CREATE TEMP TABLE document_rekey ON COMMIT DROP AS
SELECT DISTINCT ON (doc.source_id)
       doc.document_id,
       'document-' || left(
         encode(sha256(convert_to(source.source_key, 'UTF8')), 'hex'), 48
       ) AS expected_key
  FROM document AS doc
  JOIN data_source AS source ON source.source_id = doc.source_id
 ORDER BY doc.source_id,
          (doc.document_key = 'document-' || left(
             encode(sha256(convert_to(source.source_key, 'UTF8')), 'hex'), 48
           )) DESC,
          doc.document_id;

-- A source resolves to exactly one document key, so any extra document under the
-- same source is an orphaned copy that nothing can address. Those are dropped;
-- keeping them would collide with the re-key below.
CREATE TEMP TABLE orphan_document ON COMMIT DROP AS
SELECT document_id
  FROM document
 WHERE document_id NOT IN (SELECT document_id FROM document_rekey);

DELETE FROM document_chunk_embedding
WHERE chunk_id IN (
  SELECT chunk_id FROM document_chunk
   WHERE document_id IN (SELECT document_id FROM orphan_document)
);

DELETE FROM document_chunk
WHERE document_id IN (SELECT document_id FROM orphan_document);

DELETE FROM document_page
WHERE document_id IN (SELECT document_id FROM orphan_document);

DELETE FROM document_processing_version
WHERE document_id IN (SELECT document_id FROM orphan_document);

DELETE FROM document
WHERE document_id IN (SELECT document_id FROM orphan_document);

UPDATE document AS doc
   SET document_key = rekey.expected_key
  FROM document_rekey AS rekey
 WHERE rekey.document_id = doc.document_id
   AND doc.document_key <> rekey.expected_key;

COMMIT;
