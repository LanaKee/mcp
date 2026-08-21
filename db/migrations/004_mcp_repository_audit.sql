BEGIN;

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

CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_created
  ON mcp_tool_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_tool_time
  ON mcp_tool_audit(tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_expires
  ON mcp_tool_audit(expires_at);
CREATE INDEX IF NOT EXISTS idx_council_title_fts
  ON council_record USING gin(to_tsvector('simple', title));

COMMIT;
