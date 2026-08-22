-- Remove deployed synthetic/demo facts and their dedicated sources.
-- Product schemas keep the historical enum values so old audit payloads remain readable,
-- but no load path may recreate these rows.

DELETE FROM source_locator
WHERE source_id IN (
  SELECT source_id FROM data_source WHERE data_status = 'demo_sample'
);

DELETE FROM population_observation WHERE data_status = 'demo_sample';
DELETE FROM local_tax_revenue WHERE data_status = 'demo_sample';
DELETE FROM policy_program WHERE data_status = 'demo_sample';
DELETE FROM council_record WHERE data_status = 'demo_sample';
DELETE FROM document_processing_version WHERE data_status = 'demo_sample';
DELETE FROM document WHERE data_status = 'demo_sample';

DELETE FROM mcp_tool_audit
WHERE data_statuses @> ARRAY['demo_sample']::text[];

DELETE FROM data_source
WHERE data_status = 'demo_sample';
