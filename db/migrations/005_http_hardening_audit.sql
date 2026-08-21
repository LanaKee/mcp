BEGIN;

ALTER TABLE mcp_tool_audit
  ADD COLUMN IF NOT EXISTS correlation_id varchar(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mcp_tool_audit_correlation_format'
      AND conrelid = 'mcp_tool_audit'::regclass
  ) THEN
    ALTER TABLE mcp_tool_audit
      ADD CONSTRAINT mcp_tool_audit_correlation_format
      CHECK (
        correlation_id IS NULL
        OR correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$'
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_correlation
  ON mcp_tool_audit(correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMIT;
