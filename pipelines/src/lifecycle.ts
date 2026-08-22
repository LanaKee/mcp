import { createHash } from "node:crypto";
import { Client, type QueryResultRow } from "pg";
import { classifyDatabaseError, DatabaseOperationError } from "./db.js";

export const DEFAULT_MIN_RETENTION_DAYS = 30;
export const LIFECYCLE_LOCK_KEYS = [1196574284, 1886351212] as const;
export const MAINTENANCE_TABLES = [
  "document",
  "document_page",
  "document_chunk",
  "document_chunk_embedding",
  "document_processing_version",
  "source_locator",
  "mcp_tool_audit",
  "mcp_tool_audit_daily"
] as const;

export type MaintenanceTable = (typeof MAINTENANCE_TABLES)[number];
export type ProcessingVersionState = "candidate" | "approved" | "retired";
export type PurgeOperation = "stale_purge" | "audit_purge";

export interface ProcessingVersionStatus {
  versionKey: string;
  extractorVersion: string;
  chunkerVersion: string;
  approvalState: ProcessingVersionState;
  activatedAt: string | null;
  activatedBy: string | null;
  activationReason: string | null;
  retiredAt: string | null;
  retiredBy: string | null;
  retirementReason: string | null;
  chunks: number;
  currentChunks: number;
  embeddings: number;
  documents: number;
}

export interface CapacityThresholds {
  staleRatioPercent: number;
  databaseBytes: number;
  embeddingRows: number;
  expiredAuditRows: number;
}

export interface StorageCapacityReport {
  generatedAt: string;
  counts: {
    currentChunks: number;
    staleChunks: number;
    approvedCurrentChunks: number;
    currentEmbeddings: number;
    staleEmbeddings: number;
    currentPages: number;
    stalePages: number;
    documentVersions: number;
    orphanDocumentLocators: number;
    auditRows: number;
    expiredAuditRows: number;
  };
  logicalBytes: {
    currentChunks: number;
    staleChunks: number;
    currentEmbeddings: number;
    staleEmbeddings: number;
  };
  sizes: {
    databaseBytes: number;
    relations: Record<string, { tableBytes: number; indexBytes: number; totalBytes: number }>;
  };
  settings: Record<string, string>;
  versions: ProcessingVersionStatus[];
  thresholds: CapacityThresholds;
  warnings: string[];
}

export interface PurgeEntityPlan {
  count: number;
  logicalBytes: number;
  contentHash: string;
}

export interface PurgePlan {
  operation: PurgeOperation;
  requestedAt: string;
  cutoff: string;
  retentionDays: number;
  approvedVersion: string | null;
  entities: Record<string, PurgeEntityPlan>;
  totalRows: number;
  logicalBytes: number;
}

export interface PlannedPurge {
  maintenanceRunId: string;
  token: string;
  plan: PurgePlan;
}

export interface PurgeExecutionResult {
  maintenanceRunId: string;
  operation: PurgeOperation;
  status: "partial" | "succeeded";
  deleted: Record<string, number>;
  logicalBytesEstimate: number;
  remainingEligibleRows: number;
  elapsedMs: number;
}

export interface MaintenanceResult {
  operation: "analyze" | "vacuum";
  tables: MaintenanceTable[];
  settings: Record<string, string>;
  status: "succeeded";
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function envInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function loadCapacityThresholds(
  env: NodeJS.ProcessEnv = process.env
): CapacityThresholds {
  return {
    staleRatioPercent: envInteger(
      env,
      "STORAGE_WARN_STALE_RATIO_PERCENT",
      25,
      1,
      100
    ),
    databaseBytes: envInteger(
      env,
      "STORAGE_WARN_DATABASE_BYTES",
      2_147_483_648,
      1_048_576,
      Number.MAX_SAFE_INTEGER
    ),
    embeddingRows: envInteger(
      env,
      "STORAGE_WARN_EMBEDDING_ROWS",
      250_000,
      1_000,
      100_000_000
    ),
    expiredAuditRows: envInteger(
      env,
      "STORAGE_WARN_EXPIRED_AUDIT_ROWS",
      10_000,
      1,
      100_000_000
    )
  };
}

export function minimumRetentionDays(
  env: NodeJS.ProcessEnv = process.env
): number {
  return envInteger(
    env,
    "LIFECYCLE_MIN_RETENTION_DAYS",
    DEFAULT_MIN_RETENTION_DAYS,
    1,
    3650
  );
}

export function enforceRetentionDays(
  requested: number,
  minimum = DEFAULT_MIN_RETENTION_DAYS
): number {
  if (!Number.isInteger(requested) || requested < minimum || requested > 3650) {
    throw new Error(
      `retention days must be an integer from ${minimum} to 3650`
    );
  }
  return requested;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function confirmationToken(plan: PurgePlan): string {
  return createHash("sha256")
    .update(`gyeongbuk-storage-plan-v1\n${canonicalJson(plan)}`)
    .digest("hex");
}

export function validateConfirmationToken(
  plan: PurgePlan,
  token: string
): boolean {
  return /^[a-f0-9]{64}$/u.test(token) && confirmationToken(plan) === token;
}

export function validateActorReason(actor: string, reason: string): void {
  if (
    actor.length < 2 ||
    actor.length > 120 ||
    reason.length < 5 ||
    reason.length > 500 ||
    /[\u0000-\u001f\u007f]/u.test(`${actor}${reason}`)
  ) {
    throw new Error(
      "actor must be 2-120 characters and reason must be 5-500 printable characters"
    );
  }
}

export function validateMaintenanceTables(values: string[]): MaintenanceTable[] {
  const selected = [...new Set(values)];
  if (
    selected.length === 0 ||
    selected.some(
      (value) => !MAINTENANCE_TABLES.includes(value as MaintenanceTable)
    )
  ) {
    throw new Error(
      `maintenance tables must be selected from: ${MAINTENANCE_TABLES.join(", ")}`
    );
  }
  return selected as MaintenanceTable[];
}

export function capacityWarnings(
  counts: StorageCapacityReport["counts"],
  sizes: StorageCapacityReport["sizes"],
  thresholds: CapacityThresholds
): string[] {
  const warnings: string[] = [];
  const totalChunks = counts.currentChunks + counts.staleChunks;
  const staleRatio =
    totalChunks === 0 ? 0 : (counts.staleChunks / totalChunks) * 100;
  if (staleRatio >= thresholds.staleRatioPercent) {
    warnings.push(
      `stale_chunk_ratio:${staleRatio.toFixed(1)}%>=${thresholds.staleRatioPercent}%`
    );
  }
  if (sizes.databaseBytes >= thresholds.databaseBytes) {
    warnings.push(
      `database_bytes:${sizes.databaseBytes}>=${thresholds.databaseBytes}`
    );
  }
  if (
    counts.currentEmbeddings + counts.staleEmbeddings >=
    thresholds.embeddingRows
  ) {
    warnings.push(
      `embedding_rows:${counts.currentEmbeddings + counts.staleEmbeddings}>=${thresholds.embeddingRows}`
    );
  }
  if (counts.expiredAuditRows >= thresholds.expiredAuditRows) {
    warnings.push(
      `expired_audit_rows:${counts.expiredAuditRows}>=${thresholds.expiredAuditRows}`
    );
  }
  if (counts.currentChunks !== counts.approvedCurrentChunks) {
    warnings.push(
      `unapproved_current_chunks:${counts.currentChunks - counts.approvedCurrentChunks}`
    );
  }
  return warnings;
}

async function tryLifecycleLock(client: Client): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1, $2) AS locked",
    [...LIFECYCLE_LOCK_KEYS]
  );
  return result.rows[0]?.locked === true;
}

async function unlockLifecycle(client: Client): Promise<void> {
  await client
    .query("SELECT pg_advisory_unlock($1, $2)", [...LIFECYCLE_LOCK_KEYS])
    .catch(() => undefined);
}

export async function storageCapacityReport(
  client: Client,
  thresholds = loadCapacityThresholds()
): Promise<StorageCapacityReport> {
  const countResult = await client.query<{
    current_chunks: string;
    stale_chunks: string;
    approved_current_chunks: string;
    current_embeddings: string;
    stale_embeddings: string;
    current_pages: string;
    stale_pages: string;
    document_versions: string;
    orphan_document_locators: string;
    audit_rows: string;
    expired_audit_rows: string;
    current_chunk_bytes: string;
    stale_chunk_bytes: string;
    current_embedding_bytes: string;
    stale_embedding_bytes: string;
  }>(`
    SELECT
      (SELECT count(*) FROM document_chunk WHERE is_current)::text AS current_chunks,
      (SELECT count(*) FROM document_chunk WHERE NOT is_current)::text AS stale_chunks,
      (SELECT count(*) FROM document_chunk WHERE is_current AND approved_current)::text
        AS approved_current_chunks,
      (
        SELECT count(*)
          FROM document_chunk_embedding embedding
          JOIN document_chunk chunk ON chunk.chunk_id = embedding.chunk_id
         WHERE chunk.is_current AND chunk.approved_current
      )::text AS current_embeddings,
      (
        SELECT count(*)
          FROM document_chunk_embedding embedding
          JOIN document_chunk chunk ON chunk.chunk_id = embedding.chunk_id
         WHERE NOT chunk.is_current
      )::text AS stale_embeddings,
      (SELECT count(*) FROM document_page WHERE is_current)::text AS current_pages,
      (SELECT count(*) FROM document_page WHERE NOT is_current)::text AS stale_pages,
      (SELECT count(*) FROM document_processing_version)::text AS document_versions,
      (
        SELECT count(*)
          FROM source_locator locator
         WHERE locator.entity_type IN ('document', 'document_page', 'document_chunk')
           AND (
             (locator.entity_type = 'document'
               AND NOT EXISTS (
                 SELECT 1 FROM document value WHERE value.document_key = locator.entity_key
               ))
             OR
             (locator.entity_type = 'document_page'
               AND NOT EXISTS (
                 SELECT 1 FROM document_page value WHERE value.page_key = locator.entity_key
               ))
             OR
             (locator.entity_type = 'document_chunk'
               AND NOT EXISTS (
                 SELECT 1 FROM document_chunk value WHERE value.chunk_key = locator.entity_key
               ))
           )
      )::text AS orphan_document_locators,
      (SELECT count(*) FROM mcp_tool_audit)::text AS audit_rows,
      (SELECT count(*) FROM mcp_tool_audit WHERE expires_at < now())::text
        AS expired_audit_rows,
      (
        SELECT coalesce(sum(octet_length(content) + octet_length(metadata::text)), 0)
          FROM document_chunk
         WHERE is_current AND approved_current
      )::text AS current_chunk_bytes,
      (
        SELECT coalesce(sum(octet_length(content) + octet_length(metadata::text)), 0)
          FROM document_chunk
         WHERE NOT is_current
      )::text AS stale_chunk_bytes,
      (
        SELECT coalesce(sum(cardinality(embedding) * 4 + octet_length(embedding.metadata::text)), 0)
          FROM document_chunk_embedding embedding
          JOIN document_chunk chunk ON chunk.chunk_id = embedding.chunk_id
         WHERE chunk.is_current AND chunk.approved_current
      )::text AS current_embedding_bytes,
      (
        SELECT coalesce(sum(cardinality(embedding) * 4 + octet_length(embedding.metadata::text)), 0)
          FROM document_chunk_embedding embedding
          JOIN document_chunk chunk ON chunk.chunk_id = embedding.chunk_id
         WHERE NOT chunk.is_current
      )::text AS stale_embedding_bytes
  `);
  const row = countResult.rows[0]!;
  const relationResult = await client.query<{
    relation_name: string;
    table_bytes: string;
    index_bytes: string;
    total_bytes: string;
  }>(
    `SELECT
       relation::text AS relation_name,
       pg_relation_size(relation)::text AS table_bytes,
       pg_indexes_size(relation)::text AS index_bytes,
       pg_total_relation_size(relation)::text AS total_bytes
     FROM unnest($1::regclass[]) AS relation
     ORDER BY relation::text`,
    [[
      "document",
      "document_page",
      "document_chunk",
      "document_chunk_embedding",
      "source_locator",
      "mcp_tool_audit"
    ]]
  );
  const databaseSize = await client.query<{ database_bytes: string }>(
    "SELECT pg_database_size(current_database())::text AS database_bytes"
  );
  const settingsResult = await client.query<Record<string, string>>(`
    SELECT
      current_setting('server_version') AS server_version,
      current_setting('shared_buffers') AS shared_buffers,
      current_setting('work_mem') AS work_mem,
      current_setting('maintenance_work_mem') AS maintenance_work_mem,
      current_setting('max_parallel_maintenance_workers') AS max_parallel_maintenance_workers,
      current_setting('dynamic_shared_memory_type') AS dynamic_shared_memory_type,
      current_setting('statement_timeout') AS statement_timeout
  `);
  const versionResult = await client.query<{
    version_key: string;
    extractor_version: string;
    chunker_version: string;
    approval_state: ProcessingVersionState;
    activated_at: Date | string | null;
    activated_by: string | null;
    activation_reason: string | null;
    retired_at: Date | string | null;
    retired_by: string | null;
    retirement_reason: string | null;
    chunks: string;
    current_chunks: string;
    embeddings: string;
    documents: string;
  }>(`
    SELECT
      version.version_key,
      version.extractor_version,
      version.chunker_version,
      version.approval_state,
      version.activated_at,
      version.activated_by,
      version.activation_reason,
      version.retired_at,
      version.retired_by,
      version.retirement_reason,
      count(DISTINCT chunk.chunk_id)::text AS chunks,
      count(DISTINCT chunk.chunk_id) FILTER (WHERE chunk.is_current)::text AS current_chunks,
      count(DISTINCT embedding.chunk_id)::text AS embeddings,
      count(DISTINCT document_version.document_id)::text AS documents
    FROM pdf_processing_version version
    LEFT JOIN document_chunk chunk
      ON chunk.processing_version_key = version.version_key
    LEFT JOIN document_chunk_embedding embedding
      ON embedding.chunk_id = chunk.chunk_id
    LEFT JOIN document_processing_version document_version
      ON document_version.version_key = version.version_key
    GROUP BY version.version_key
    ORDER BY
      CASE version.approval_state WHEN 'approved' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
      version.updated_at DESC
  `);
  const counts = {
    currentChunks: numberValue(row.current_chunks),
    staleChunks: numberValue(row.stale_chunks),
    approvedCurrentChunks: numberValue(row.approved_current_chunks),
    currentEmbeddings: numberValue(row.current_embeddings),
    staleEmbeddings: numberValue(row.stale_embeddings),
    currentPages: numberValue(row.current_pages),
    stalePages: numberValue(row.stale_pages),
    documentVersions: numberValue(row.document_versions),
    orphanDocumentLocators: numberValue(row.orphan_document_locators),
    auditRows: numberValue(row.audit_rows),
    expiredAuditRows: numberValue(row.expired_audit_rows)
  };
  const sizes = {
    databaseBytes: numberValue(databaseSize.rows[0]?.database_bytes),
    relations: Object.fromEntries(
      relationResult.rows.map((value) => [
        value.relation_name,
        {
          tableBytes: numberValue(value.table_bytes),
          indexBytes: numberValue(value.index_bytes),
          totalBytes: numberValue(value.total_bytes)
        }
      ])
    )
  };
  return {
    generatedAt: new Date().toISOString(),
    counts,
    logicalBytes: {
      currentChunks: numberValue(row.current_chunk_bytes),
      staleChunks: numberValue(row.stale_chunk_bytes),
      currentEmbeddings: numberValue(row.current_embedding_bytes),
      staleEmbeddings: numberValue(row.stale_embedding_bytes)
    },
    sizes,
    settings: settingsResult.rows[0] ?? {},
    versions: versionResult.rows.map((version) => ({
      versionKey: version.version_key,
      extractorVersion: version.extractor_version,
      chunkerVersion: version.chunker_version,
      approvalState: version.approval_state,
      activatedAt: version.activated_at
        ? new Date(version.activated_at).toISOString()
        : null,
      activatedBy: version.activated_by,
      activationReason: version.activation_reason,
      retiredAt: version.retired_at
        ? new Date(version.retired_at).toISOString()
        : null,
      retiredBy: version.retired_by,
      retirementReason: version.retirement_reason,
      chunks: numberValue(version.chunks),
      currentChunks: numberValue(version.current_chunks),
      embeddings: numberValue(version.embeddings),
      documents: numberValue(version.documents)
    })),
    thresholds,
    warnings: capacityWarnings(counts, sizes, thresholds)
  };
}

async function approvedVersion(client: Client): Promise<string | null> {
  const result = await client.query<{ version_key: string }>(
    `SELECT version_key
       FROM pdf_processing_version
      WHERE approval_state = 'approved'
      LIMIT 1`
  );
  return result.rows[0]?.version_key ?? null;
}

async function entitySnapshot(
  client: Client,
  query: string,
  values: unknown[]
): Promise<PurgeEntityPlan> {
  const result = await client.query<{
    row_count: string;
    logical_bytes: string;
    content_hash: string;
  }>(query, values);
  const row = result.rows[0];
  return {
    count: numberValue(row?.row_count),
    logicalBytes: numberValue(row?.logical_bytes),
    contentHash:
      row?.content_hash ??
      createHash("sha256").update("").digest("hex")
  };
}

async function stalePlanAt(
  client: Client,
  retentionDays: number,
  requestedAt: Date
): Promise<PurgePlan> {
  const cutoff = new Date(
    requestedAt.getTime() - retentionDays * 86_400_000
  );
  const values = [cutoff];
  const chunks = await entitySnapshot(
    client,
    `SELECT
       count(*)::text AS row_count,
       coalesce(sum(octet_length(chunk.content) + octet_length(chunk.metadata::text)), 0)::text
         AS logical_bytes,
       encode(
         digest(coalesce(string_agg(chunk.chunk_id::text, ',' ORDER BY chunk.chunk_id), ''), 'sha256'),
         'hex'
       ) AS content_hash
     FROM document_chunk chunk
     JOIN pdf_processing_version version
       ON version.version_key = chunk.processing_version_key
     WHERE NOT chunk.is_current
       AND NOT chunk.approved_current
       AND version.approval_state = 'retired'
       AND chunk.stale_at < $1`,
    values
  );
  const embeddings = await entitySnapshot(
    client,
    `SELECT
       count(*)::text AS row_count,
       coalesce(sum(cardinality(embedding.embedding) * 4
         + octet_length(embedding.metadata::text)), 0)::text AS logical_bytes,
       encode(
         digest(
           coalesce(
             string_agg(
               embedding.chunk_id::text || ':' || embedding.provider || ':'
                 || embedding.model || ':' || embedding.model_version,
               ','
               ORDER BY embedding.chunk_id, embedding.provider, embedding.model,
                 embedding.model_version
             ),
             ''
           ),
           'sha256'
         ),
         'hex'
       ) AS content_hash
     FROM document_chunk_embedding embedding
     JOIN document_chunk chunk ON chunk.chunk_id = embedding.chunk_id
     JOIN pdf_processing_version version
       ON version.version_key = chunk.processing_version_key
     WHERE NOT chunk.is_current
       AND NOT chunk.approved_current
       AND version.approval_state = 'retired'
       AND chunk.stale_at < $1`,
    values
  );
  const chunkLocators = await entitySnapshot(
    client,
    `SELECT
       count(*)::text AS row_count,
       coalesce(sum(coalesce(octet_length(locator.locator_text), 0) + 96), 0)::text
         AS logical_bytes,
       encode(
         digest(
           coalesce(
             string_agg(locator.source_locator_id::text, ',' ORDER BY locator.source_locator_id),
             ''
           ),
           'sha256'
         ),
         'hex'
       ) AS content_hash
     FROM source_locator locator
     JOIN document_chunk chunk
       ON locator.entity_type = 'document_chunk'
      AND locator.entity_key = chunk.chunk_key
     JOIN pdf_processing_version version
       ON version.version_key = chunk.processing_version_key
     WHERE NOT chunk.is_current
       AND NOT chunk.approved_current
       AND version.approval_state = 'retired'
       AND chunk.stale_at < $1`,
    values
  );
  const pages = await entitySnapshot(
    client,
    `SELECT
       count(*)::text AS row_count,
       coalesce(sum(octet_length(page.metadata::text) + 128), 0)::text AS logical_bytes,
       encode(
         digest(coalesce(string_agg(page.page_id::text, ',' ORDER BY page.page_id), ''), 'sha256'),
         'hex'
       ) AS content_hash
     FROM document_page page
     WHERE NOT page.is_current
       AND page.stale_at < $1
       AND NOT EXISTS (
         SELECT 1
           FROM pdf_processing_version version
          WHERE version.extractor_version = page.extractor_version
            AND version.approval_state IN ('candidate', 'approved')
       )`,
    values
  );
  const pageLocators = await entitySnapshot(
    client,
    `SELECT
       count(*)::text AS row_count,
       coalesce(sum(coalesce(octet_length(locator.locator_text), 0) + 96), 0)::text
         AS logical_bytes,
       encode(
         digest(
           coalesce(
             string_agg(locator.source_locator_id::text, ',' ORDER BY locator.source_locator_id),
             ''
           ),
           'sha256'
         ),
         'hex'
       ) AS content_hash
     FROM source_locator locator
     JOIN document_page page
       ON locator.entity_type = 'document_page'
      AND locator.entity_key = page.page_key
     WHERE NOT page.is_current
       AND page.stale_at < $1
       AND NOT EXISTS (
         SELECT 1
           FROM pdf_processing_version version
          WHERE version.extractor_version = page.extractor_version
            AND version.approval_state IN ('candidate', 'approved')
       )`,
    values
  );
  const documentVersions = await entitySnapshot(
    client,
    `SELECT
       count(*)::text AS row_count,
       coalesce(sum(octet_length(document_version.metadata::text) + 128), 0)::text
         AS logical_bytes,
       encode(
         digest(
           coalesce(
             string_agg(
               document_version.document_id::text || ':' || document_version.version_key,
               ','
               ORDER BY document_version.document_id, document_version.version_key
             ),
             ''
           ),
           'sha256'
         ),
         'hex'
       ) AS content_hash
     FROM document_processing_version document_version
     JOIN pdf_processing_version version
       ON version.version_key = document_version.version_key
     WHERE version.approval_state = 'retired'
       AND document_version.stale_at < $1
       AND NOT EXISTS (
         SELECT 1
           FROM document_chunk chunk
          WHERE chunk.document_id = document_version.document_id
            AND chunk.processing_version_key = document_version.version_key
            AND (
              chunk.is_current
              OR chunk.approved_current
              OR chunk.stale_at IS NULL
              OR chunk.stale_at >= $1
            )
       )`,
    values
  );
  const orphanLocators = await entitySnapshot(
    client,
    `SELECT
       count(*)::text AS row_count,
       coalesce(sum(coalesce(octet_length(locator.locator_text), 0) + 96), 0)::text
         AS logical_bytes,
       encode(
         digest(
           coalesce(
             string_agg(locator.source_locator_id::text, ',' ORDER BY locator.source_locator_id),
             ''
           ),
           'sha256'
         ),
         'hex'
       ) AS content_hash
     FROM source_locator locator
     WHERE locator.created_at < $1
       AND locator.entity_type IN ('document', 'document_page', 'document_chunk')
       AND (
         (locator.entity_type = 'document'
           AND NOT EXISTS (
             SELECT 1 FROM document value WHERE value.document_key = locator.entity_key
           ))
         OR
         (locator.entity_type = 'document_page'
           AND NOT EXISTS (
             SELECT 1 FROM document_page value WHERE value.page_key = locator.entity_key
           ))
         OR
         (locator.entity_type = 'document_chunk'
           AND NOT EXISTS (
             SELECT 1 FROM document_chunk value WHERE value.chunk_key = locator.entity_key
           ))
       )`,
    values
  );
  const entities = {
    chunks,
    embeddings,
    chunkLocators,
    pages,
    pageLocators,
    documentVersions,
    orphanLocators
  };
  return {
    operation: "stale_purge",
    requestedAt: requestedAt.toISOString(),
    cutoff: cutoff.toISOString(),
    retentionDays,
    approvedVersion: await approvedVersion(client),
    entities,
    totalRows: Object.values(entities).reduce(
      (total, entity) => total + entity.count,
      0
    ),
    logicalBytes: Object.values(entities).reduce(
      (total, entity) => total + entity.logicalBytes,
      0
    )
  };
}

async function auditPlanAt(
  client: Client,
  requestedAt: Date
): Promise<PurgePlan> {
  const audits = await entitySnapshot(
    client,
    `SELECT
       count(*)::text AS row_count,
       coalesce(
         sum(
           octet_length(request_metadata::text)
           + octet_length(request_hash)
           + octet_length(tool_name)
           + 128
         ),
         0
       )::text AS logical_bytes,
       encode(
         digest(coalesce(string_agg(audit_id::text, ',' ORDER BY audit_id), ''), 'sha256'),
         'hex'
       ) AS content_hash
     FROM mcp_tool_audit
     WHERE expires_at < $1`,
    [requestedAt]
  );
  return {
    operation: "audit_purge",
    requestedAt: requestedAt.toISOString(),
    cutoff: requestedAt.toISOString(),
    retentionDays: 0,
    approvedVersion: await approvedVersion(client),
    entities: { audits },
    totalRows: audits.count,
    logicalBytes: audits.logicalBytes
  };
}

export async function createPurgePlan(
  client: Client,
  options: {
    operation: PurgeOperation;
    retentionDays?: number;
    minimumRetentionDays?: number;
    actor: string;
    now?: Date;
  }
): Promise<PlannedPurge> {
  validateActorReason(options.actor, "Create bounded purge plan");
  const now = options.now ?? new Date();
  const retentionDays =
    options.operation === "stale_purge"
      ? enforceRetentionDays(
          options.retentionDays ?? DEFAULT_MIN_RETENTION_DAYS,
          options.minimumRetentionDays ?? minimumRetentionDays()
        )
      : 0;
  const plan =
    options.operation === "stale_purge"
      ? await stalePlanAt(client, retentionDays, now)
      : await auditPlanAt(client, now);
  const token = confirmationToken(plan);
  const inserted = await client.query<{ maintenance_run_id: string }>(
    `INSERT INTO storage_maintenance_run
      (
        operation, status, dry_run, requested_by, plan_token,
        retention_days, plan, result
      )
     VALUES ($1, 'planned', true, $2, $3, $4, $5::jsonb, '{}'::jsonb)
     RETURNING maintenance_run_id`,
    [
      options.operation,
      options.actor,
      token,
      retentionDays,
      JSON.stringify(plan)
    ]
  );
  return {
    maintenanceRunId: inserted.rows[0]!.maintenance_run_id,
    token,
    plan
  };
}

async function loadPlannedPurge(
  client: Client,
  token: string
): Promise<{
  maintenanceRunId: string;
  status: string;
  plan: PurgePlan;
  actor: string;
  expectedRemainingToken: string | null;
}> {
  const result = await client.query<{
    maintenance_run_id: string;
    status: string;
    plan: PurgePlan;
    requested_by: string;
    result: { remainingPlanToken?: unknown };
  }>(
    `SELECT maintenance_run_id, status, plan, requested_by, result
       FROM storage_maintenance_run
      WHERE plan_token = $1
        AND operation IN ('stale_purge', 'audit_purge')
      ORDER BY requested_at DESC
      LIMIT 1`,
    [token]
  );
  const row = result.rows[0];
  if (!row) throw new Error("No purge plan matches the confirmation token");
  if (!validateConfirmationToken(row.plan, token)) {
    throw new Error("Stored purge plan failed confirmation-token validation");
  }
  if (!["planned", "partial"].includes(row.status)) {
    throw new Error(`Purge plan is not executable from status ${row.status}`);
  }
  return {
    maintenanceRunId: row.maintenance_run_id,
    status: row.status,
    plan: row.plan,
    actor: row.requested_by,
    expectedRemainingToken:
      typeof row.result?.remainingPlanToken === "string"
        ? row.result.remainingPlanToken
        : null
  };
}

interface BatchResult {
  primaryRows: number;
  deleted: Record<string, number>;
}

async function deleteChunkBatch(
  client: Client,
  cutoff: Date,
  limit: number
): Promise<BatchResult> {
  await client.query("BEGIN");
  try {
    const selected = await client.query<{ chunk_id: string; chunk_key: string }>(
      `SELECT chunk.chunk_id::text, chunk.chunk_key
         FROM document_chunk chunk
         JOIN pdf_processing_version version
           ON version.version_key = chunk.processing_version_key
        WHERE NOT chunk.is_current
          AND NOT chunk.approved_current
          AND version.approval_state = 'retired'
          AND chunk.stale_at < $1
        ORDER BY chunk.chunk_id
        LIMIT $2
        FOR UPDATE OF chunk SKIP LOCKED`,
      [cutoff, limit]
    );
    if (selected.rows.length === 0) {
      await client.query("COMMIT");
      return { primaryRows: 0, deleted: {} };
    }
    const ids = selected.rows.map((row) => row.chunk_id);
    const keys = selected.rows.map((row) => row.chunk_key);
    const locators = await client.query(
      `DELETE FROM source_locator
        WHERE entity_type = 'document_chunk'
          AND entity_key = ANY($1::text[])`,
      [keys]
    );
    const embeddings = await client.query(
      "DELETE FROM document_chunk_embedding WHERE chunk_id = ANY($1::uuid[])",
      [ids]
    );
    const chunks = await client.query(
      `DELETE FROM document_chunk
        WHERE chunk_id = ANY($1::uuid[])
          AND NOT is_current
          AND NOT approved_current`,
      [ids]
    );
    await client.query("COMMIT");
    return {
      primaryRows: chunks.rowCount ?? 0,
      deleted: {
        chunks: chunks.rowCount ?? 0,
        embeddings: embeddings.rowCount ?? 0,
        chunkLocators: locators.rowCount ?? 0
      }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function deletePageBatch(
  client: Client,
  cutoff: Date,
  limit: number
): Promise<BatchResult> {
  await client.query("BEGIN");
  try {
    const selected = await client.query<{ page_id: string; page_key: string }>(
      `SELECT page.page_id::text, page.page_key
         FROM document_page page
        WHERE NOT page.is_current
          AND page.stale_at < $1
          AND NOT EXISTS (
            SELECT 1
              FROM pdf_processing_version version
             WHERE version.extractor_version = page.extractor_version
               AND version.approval_state IN ('candidate', 'approved')
          )
        ORDER BY page.page_id
        LIMIT $2
        FOR UPDATE OF page SKIP LOCKED`,
      [cutoff, limit]
    );
    if (selected.rows.length === 0) {
      await client.query("COMMIT");
      return { primaryRows: 0, deleted: {} };
    }
    const ids = selected.rows.map((row) => row.page_id);
    const keys = selected.rows.map((row) => row.page_key);
    const locators = await client.query(
      `DELETE FROM source_locator
        WHERE entity_type = 'document_page'
          AND entity_key = ANY($1::text[])`,
      [keys]
    );
    const pages = await client.query(
      "DELETE FROM document_page WHERE page_id = ANY($1::uuid[]) AND NOT is_current",
      [ids]
    );
    await client.query("COMMIT");
    return {
      primaryRows: pages.rowCount ?? 0,
      deleted: {
        pages: pages.rowCount ?? 0,
        pageLocators: locators.rowCount ?? 0
      }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function deleteDocumentVersionBatch(
  client: Client,
  cutoff: Date,
  limit: number
): Promise<BatchResult> {
  const result = await client.query(
    `DELETE FROM document_processing_version document_version
      USING (
        SELECT value.document_id, value.version_key
          FROM document_processing_version value
          JOIN pdf_processing_version version
            ON version.version_key = value.version_key
         WHERE version.approval_state = 'retired'
           AND value.stale_at < $1
           AND NOT EXISTS (
             SELECT 1
               FROM document_chunk chunk
              WHERE chunk.document_id = value.document_id
                AND chunk.processing_version_key = value.version_key
           )
         ORDER BY value.document_id, value.version_key
         LIMIT $2
         FOR UPDATE OF value SKIP LOCKED
      ) selected
      WHERE document_version.document_id = selected.document_id
        AND document_version.version_key = selected.version_key`,
    [cutoff, limit]
  );
  return {
    primaryRows: result.rowCount ?? 0,
    deleted: { documentVersions: result.rowCount ?? 0 }
  };
}

async function deleteOrphanLocatorBatch(
  client: Client,
  cutoff: Date,
  limit: number
): Promise<BatchResult> {
  const result = await client.query(
    `DELETE FROM source_locator locator
      USING (
        SELECT value.source_locator_id
          FROM source_locator value
         WHERE value.created_at < $1
           AND value.entity_type IN ('document', 'document_page', 'document_chunk')
           AND (
             (value.entity_type = 'document'
               AND NOT EXISTS (
                 SELECT 1 FROM document entity WHERE entity.document_key = value.entity_key
               ))
             OR
             (value.entity_type = 'document_page'
               AND NOT EXISTS (
                 SELECT 1 FROM document_page entity WHERE entity.page_key = value.entity_key
               ))
             OR
             (value.entity_type = 'document_chunk'
               AND NOT EXISTS (
                 SELECT 1 FROM document_chunk entity WHERE entity.chunk_key = value.entity_key
               ))
           )
         ORDER BY value.source_locator_id
         LIMIT $2
         FOR UPDATE OF value SKIP LOCKED
      ) selected
      WHERE locator.source_locator_id = selected.source_locator_id`,
    [cutoff, limit]
  );
  return {
    primaryRows: result.rowCount ?? 0,
    deleted: { orphanLocators: result.rowCount ?? 0 }
  };
}

async function deleteAuditBatch(
  client: Client,
  cutoff: Date,
  limit: number
): Promise<BatchResult> {
  await client.query("BEGIN");
  try {
    const selected = await client.query<{ audit_id: string }>(
      `SELECT audit_id::text
         FROM mcp_tool_audit
        WHERE expires_at < $1
        ORDER BY audit_id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [cutoff, limit]
    );
    if (selected.rows.length === 0) {
      await client.query("COMMIT");
      return { primaryRows: 0, deleted: {} };
    }
    const ids = selected.rows.map((row) => row.audit_id);
    await client.query(
      `INSERT INTO mcp_tool_audit_daily
        (
          audit_date, tool_name, success, repository_mode,
          call_count, result_count_sum, duration_ms_sum, duration_ms_max
        )
       SELECT
         created_at::date,
         tool_name,
         success,
         repository_mode,
         count(*),
         sum(result_count),
         sum(duration_ms),
         max(duration_ms)
       FROM mcp_tool_audit
       WHERE audit_id = ANY($1::bigint[])
       GROUP BY created_at::date, tool_name, success, repository_mode
       ON CONFLICT (audit_date, tool_name, success, repository_mode)
       DO UPDATE SET
         call_count = mcp_tool_audit_daily.call_count + EXCLUDED.call_count,
         result_count_sum =
           mcp_tool_audit_daily.result_count_sum + EXCLUDED.result_count_sum,
         duration_ms_sum =
           mcp_tool_audit_daily.duration_ms_sum + EXCLUDED.duration_ms_sum,
         duration_ms_max =
           greatest(mcp_tool_audit_daily.duration_ms_max, EXCLUDED.duration_ms_max),
         last_aggregated_at = now()`,
      [ids]
    );
    const deleted = await client.query(
      "DELETE FROM mcp_tool_audit WHERE audit_id = ANY($1::bigint[])",
      [ids]
    );
    await client.query("COMMIT");
    return {
      primaryRows: deleted.rowCount ?? 0,
      deleted: { audits: deleted.rowCount ?? 0 }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function addDeleted(
  target: Record<string, number>,
  additions: Record<string, number>
): void {
  for (const [key, value] of Object.entries(additions)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function logicalBytesForDeleted(
  plan: PurgePlan,
  deleted: Record<string, number>
): number {
  let bytes = 0;
  const mappings: Array<[string, string]> = [
    ["chunks", "chunks"],
    ["embeddings", "embeddings"],
    ["chunkLocators", "chunkLocators"],
    ["pages", "pages"],
    ["pageLocators", "pageLocators"],
    ["documentVersions", "documentVersions"],
    ["orphanLocators", "orphanLocators"],
    ["audits", "audits"]
  ];
  for (const [deletedKey, planKey] of mappings) {
    const entity = plan.entities[planKey];
    if (!entity || entity.count === 0) continue;
    bytes +=
      (entity.logicalBytes / entity.count) * (deleted[deletedKey] ?? 0);
  }
  return Math.round(bytes);
}

export async function executePurge(
  client: Client,
  token: string,
  options: {
    batchSize?: number;
    maxRows?: number;
    maxRuntimeMs?: number;
  } = {}
): Promise<PurgeExecutionResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 500, 1), 5000);
  const maxRows = Math.min(Math.max(options.maxRows ?? 10_000, 1), 100_000);
  const maxRuntimeMs = Math.min(
    Math.max(options.maxRuntimeMs ?? 60_000, 1_000),
    900_000
  );
  const stored = await loadPlannedPurge(client, token);
  if (!(await tryLifecycleLock(client))) {
    throw new Error("storage lifecycle advisory lock is already held");
  }
  const started = Date.now();
  const deleted: Record<string, number> = {};
  let primaryDeleted = 0;
  try {
    const requestedAt = new Date(stored.plan.requestedAt);
    const current =
      stored.plan.operation === "stale_purge"
        ? await stalePlanAt(client, stored.plan.retentionDays, requestedAt)
        : await auditPlanAt(client, requestedAt);
    const expectedToken =
      stored.status === "planned" ? token : stored.expectedRemainingToken;
    if (!expectedToken || confirmationToken(current) !== expectedToken) {
      throw new Error(
        "Purge candidates changed after planning; create a new dry-run plan"
      );
    }
    return await finishPurgeExecution(
      client,
      stored,
      batchSize,
      maxRows,
      maxRuntimeMs,
      started,
      deleted,
      primaryDeleted
    );
  } catch (error) {
    await client
      .query(
        `UPDATE storage_maintenance_run
            SET status = 'failed',
                finished_at = now(),
                error_report = $2::jsonb
          WHERE maintenance_run_id = $1`,
        [
          stored.maintenanceRunId,
          JSON.stringify([
            {
              error:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : String(error).slice(0, 500)
            }
          ])
        ]
      )
      .catch(() => undefined);
    throw error;
  } finally {
    await unlockLifecycle(client);
  }
}

export function processingVersionKey(
      extractorVersion: string,
      chunkerVersion: string
    ): string {
      if (
        !extractorVersion ||
        !chunkerVersion ||
        extractorVersion.length > 160 ||
        chunkerVersion.length > 160 ||
        /[\u0000-\u001f\u007f]/u.test(`${extractorVersion}${chunkerVersion}`)
      ) {
        throw new Error("processing version values are invalid");
      }
      return `${extractorVersion}::${chunkerVersion}`;
    }

    export async function ensureProcessingVersion(
      client: Client,
      extractorVersion: string,
      chunkerVersion: string
    ): Promise<{
      versionKey: string;
      approvalState: ProcessingVersionState;
      bootstrapped: boolean;
    }> {
      const versionKey = processingVersionKey(extractorVersion, chunkerVersion);
      await client.query("BEGIN");
      try {
        await client.query(
          "SELECT pg_advisory_xact_lock($1, $2)",
          [...LIFECYCLE_LOCK_KEYS]
        );
        const identityConflict = await client.query<{ version_key: string }>(
          `SELECT version_key
             FROM pdf_processing_version
            WHERE chunker_version = $1
              AND extractor_version <> $2
            LIMIT 1`,
          [chunkerVersion, extractorVersion]
        );
        if (identityConflict.rows[0]) {
          throw new Error(
            "A chunker version cannot be reused with a different extractor; bump the chunker version to preserve retained chunk IDs"
          );
        }
        await client.query(
          `INSERT INTO pdf_processing_version
            (
              version_key, extractor_version, chunker_version, approval_state,
              metadata
            )
           VALUES ($1, $2, $3, 'candidate', $4::jsonb)
           ON CONFLICT (version_key) DO NOTHING`,
          [
            versionKey,
            extractorVersion,
            chunkerVersion,
            JSON.stringify({ registeredBy: "pdf-loader" })
          ]
        );
        const active = await client.query<{ version_key: string }>(
          `SELECT version_key
             FROM pdf_processing_version
            WHERE approval_state = 'approved'
            LIMIT 1`
        );
        let bootstrapped = false;
        if (!active.rows[0]) {
          await client.query(
            `UPDATE pdf_processing_version
                SET approval_state = 'approved',
                    activated_at = now(),
                    activated_by = 'system:bootstrap',
                    activation_reason = 'First loaded PDF processing version',
                    retired_at = NULL,
                    retired_by = NULL,
                    retirement_reason = NULL,
                    updated_at = now()
              WHERE version_key = $1`,
            [versionKey]
          );
          await client.query(
            `INSERT INTO pdf_processing_version_event
              (version_key, action, actor, reason, metadata)
             VALUES ($1, 'approve', 'system:bootstrap',
               'First loaded PDF processing version', '{}'::jsonb)`,
            [versionKey]
          );
          bootstrapped = true;
        }
        const selected = await client.query<{
          approval_state: ProcessingVersionState;
        }>(
          `SELECT approval_state
             FROM pdf_processing_version
            WHERE version_key = $1`,
          [versionKey]
        );
        await client.query("COMMIT");
        return {
          versionKey,
          approvalState: selected.rows[0]!.approval_state,
          bootstrapped
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    export async function approveProcessingVersion(
      client: Client,
      versionKey: string,
      actor: string,
      reason: string
    ): Promise<{
      versionKey: string;
      previousVersion: string | null;
      action: "approve" | "rollback" | "unchanged";
      currentChunks: number;
      currentPages: number;
    }> {
      validateActorReason(actor, reason);
      if (!(await tryLifecycleLock(client))) {
        throw new Error("storage lifecycle advisory lock is already held");
      }
      await client.query("BEGIN");
      try {
        const target = await client.query<{
          extractor_version: string;
          approval_state: ProcessingVersionState;
        }>(
          `SELECT extractor_version, approval_state
             FROM pdf_processing_version
            WHERE version_key = $1
            FOR UPDATE`,
          [versionKey]
        );
        if (!target.rows[0]) throw new Error(`Unknown processing version: ${versionKey}`);
        const active = await client.query<{ version_key: string }>(
          `SELECT version_key
             FROM pdf_processing_version
            WHERE approval_state = 'approved'
            FOR UPDATE`
        );
        const previousVersion = active.rows[0]?.version_key ?? null;
        if (previousVersion === versionKey) {
          const counts = await client.query<{
            chunks: string;
            pages: string;
          }>(
            `SELECT
              (SELECT count(*) FROM document_chunk
                WHERE is_current AND approved_current)::text AS chunks,
              (SELECT count(*) FROM document_page WHERE is_current)::text AS pages`
          );
          await client.query("COMMIT");
          return {
            versionKey,
            previousVersion,
            action: "unchanged",
            currentChunks: numberValue(counts.rows[0]?.chunks),
            currentPages: numberValue(counts.rows[0]?.pages)
          };
        }
        const coverage = await client.query<{
          target_chunks: string;
          target_documents: string;
          target_embeddings: string;
          target_pages: string;
          active_documents: string;
        }>(
          `SELECT
            (SELECT count(*) FROM document_chunk
              WHERE processing_version_key = $1)::text AS target_chunks,
            (SELECT count(*) FROM document_processing_version
              WHERE version_key = $1)::text AS target_documents,
            (
              SELECT count(DISTINCT chunk.chunk_id)
                FROM document_chunk chunk
                JOIN document_chunk_embedding embedding
                  ON embedding.chunk_id = chunk.chunk_id
               WHERE chunk.processing_version_key = $1
            )::text AS target_embeddings,
            (SELECT count(*) FROM document_page
              WHERE extractor_version = $2)::text AS target_pages,
            (SELECT count(*) FROM document_processing_version
              WHERE version_key = $3)::text AS active_documents`,
          [
            versionKey,
            target.rows[0].extractor_version,
            previousVersion
          ]
        );
        const coverageRow = coverage.rows[0]!;
        const targetChunks = numberValue(coverageRow.target_chunks);
        const targetDocuments = numberValue(coverageRow.target_documents);
        const activeDocuments = numberValue(coverageRow.active_documents);
        if (targetChunks === 0 || targetDocuments === 0) {
          throw new Error("Target version has no retained chunks/documents");
        }
        if (previousVersion && targetDocuments < activeDocuments) {
          throw new Error(
            `Target version is incomplete: ${targetDocuments} documents < ${activeDocuments}`
          );
        }
        if (numberValue(coverageRow.target_embeddings) < targetChunks) {
          throw new Error("Target version has chunks without retained embeddings");
        }
        if (previousVersion) {
          await client.query(
            `UPDATE pdf_processing_version
                SET approval_state = 'retired',
                    retired_at = now(),
                    retired_by = $2,
                    retirement_reason = $3,
                    updated_at = now()
              WHERE version_key = $1`,
            [previousVersion, actor, `Replaced by ${versionKey}: ${reason}`]
          );
          await client.query(
            `INSERT INTO pdf_processing_version_event
              (version_key, action, actor, reason, metadata)
             VALUES ($1, 'retire', $2, $3, $4::jsonb)`,
            [
              previousVersion,
              actor,
              `Replaced by ${versionKey}: ${reason}`,
              JSON.stringify({ replacementVersion: versionKey })
            ]
          );
        }
        const action =
          target.rows[0].approval_state === "retired" ? "rollback" : "approve";
        await client.query(
          `UPDATE pdf_processing_version
              SET approval_state = 'approved',
                  activated_at = now(),
                  activated_by = $2,
                  activation_reason = $3,
                  retired_at = NULL,
                  retired_by = NULL,
                  retirement_reason = NULL,
                  updated_at = now()
            WHERE version_key = $1`,
          [versionKey, actor, reason]
        );
        await client.query(
          `INSERT INTO pdf_processing_version_event
            (version_key, action, actor, reason, metadata)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            versionKey,
            action,
            actor,
            reason,
            JSON.stringify({ previousVersion })
          ]
        );
        await client.query(
          `UPDATE document_chunk
              SET is_current = false,
                  approved_current = false,
                  stale_at = coalesce(stale_at, now())
            WHERE is_current OR approved_current`
        );
        await client.query(
          `UPDATE document_chunk
              SET is_current = true,
                  approved_current = true,
                  stale_at = NULL
            WHERE processing_version_key = $1`,
          [versionKey]
        );
        await client.query(
          `UPDATE document_processing_version
              SET stale_at = CASE WHEN version_key = $1 THEN NULL
                                  ELSE coalesce(stale_at, now()) END`,
          [versionKey]
        );
        if (numberValue(coverageRow.target_pages) > 0) {
          await client.query(
            `UPDATE document_page
                SET is_current = false,
                    stale_at = coalesce(stale_at, now())
              WHERE is_current`
          );
          await client.query(
            `UPDATE document_page
                SET is_current = true,
                    stale_at = NULL
              WHERE extractor_version = $1`,
            [target.rows[0].extractor_version]
          );
        }
        await client.query(
          `UPDATE document document_row
              SET extraction_status = version.extraction_status,
                  page_count = version.page_count,
                  content_sha256 = version.content_sha256,
                  data_status = version.data_status,
                  ingestion_run_id = version.ingestion_run_id,
                  metadata = version.metadata
             FROM document_processing_version version
            WHERE version.document_id = document_row.document_id
              AND version.version_key = $1`,
          [versionKey]
        );
        const current = await client.query<{ chunks: string; pages: string }>(
          `SELECT
            (SELECT count(*) FROM document_chunk
              WHERE is_current AND approved_current)::text AS chunks,
            (SELECT count(*) FROM document_page WHERE is_current)::text AS pages`
        );
        await client.query("COMMIT");
        return {
          versionKey,
          previousVersion,
          action,
          currentChunks: numberValue(current.rows[0]?.chunks),
          currentPages: numberValue(current.rows[0]?.pages)
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await unlockLifecycle(client);
      }
    }

    export async function retireProcessingVersion(
      client: Client,
      versionKey: string,
      actor: string,
      reason: string
    ): Promise<{ versionKey: string; approvalState: ProcessingVersionState }> {
      validateActorReason(actor, reason);
      if (!(await tryLifecycleLock(client))) {
        throw new Error("storage lifecycle advisory lock is already held");
      }
      await client.query("BEGIN");
      try {
        const selected = await client.query<{
          approval_state: ProcessingVersionState;
        }>(
          `SELECT approval_state
             FROM pdf_processing_version
            WHERE version_key = $1
            FOR UPDATE`,
          [versionKey]
        );
        const state = selected.rows[0]?.approval_state;
        if (!state) throw new Error(`Unknown processing version: ${versionKey}`);
        if (state === "approved") {
          throw new Error(
            "Cannot retire the approved version; approve a retained replacement first"
          );
        }
        if (state !== "retired") {
          await client.query(
            `UPDATE pdf_processing_version
                SET approval_state = 'retired',
                    retired_at = now(),
                    retired_by = $2,
                    retirement_reason = $3,
                    updated_at = now()
              WHERE version_key = $1`,
            [versionKey, actor, reason]
          );
          await client.query(
            `UPDATE document_chunk
                SET is_current = false,
                    approved_current = false,
                    stale_at = coalesce(stale_at, now())
              WHERE processing_version_key = $1`,
            [versionKey]
          );
          await client.query(
            `UPDATE document_processing_version
                SET stale_at = coalesce(stale_at, now())
              WHERE version_key = $1`,
            [versionKey]
          );
          await client.query(
            `INSERT INTO pdf_processing_version_event
              (version_key, action, actor, reason, metadata)
             VALUES ($1, 'retire', $2, $3, '{}'::jsonb)`,
            [versionKey, actor, reason]
          );
        }
        await client.query("COMMIT");
        return { versionKey, approvalState: "retired" };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await unlockLifecycle(client);
      }
    }

    function maintenanceRemediation(error: unknown): Error {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (code === "53100") {
        return new Error(
          "PostgreSQL VACUUM failed with 53100 (insufficient shared memory/disk-backed shared segment). Do not retry blindly: inspect /dev/shm or container shm_size, maintenance_work_mem, parallel maintenance workers, free disk, then schedule a maintenance window. ANALYZE-only remains safe."
        );
      }
      return error instanceof Error ? error : new Error(String(error));
    }

    export async function runPostPurgeMaintenance(
      client: Client,
      options: {
        operation?: "analyze" | "vacuum";
        tables?: string[];
        actor: string;
        statementTimeoutMs?: number;
        confirmVacuum?: boolean;
      }
    ): Promise<MaintenanceResult> {
      validateActorReason(options.actor, "Run bounded storage maintenance");
      const operation = options.operation ?? "analyze";
      if (operation === "vacuum" && options.confirmVacuum !== true) {
        throw new Error("VACUUM requires the explicit --confirm-vacuum option");
      }
      const tables = validateMaintenanceTables(
        options.tables ?? [
          "document_chunk",
          "document_chunk_embedding",
          "document_page"
        ]
      );
      const timeout = Math.min(
        Math.max(options.statementTimeoutMs ?? 600_000, 1_000),
        900_000
      );
      if (!(await tryLifecycleLock(client))) {
        throw new Error("storage lifecycle advisory lock is already held");
      }
      let maintenanceRunId: string | null = null;
      try {
        const inserted = await client.query<{ maintenance_run_id: string }>(
          `INSERT INTO storage_maintenance_run
            (operation, status, dry_run, requested_by, plan, started_at)
           VALUES ($1, 'running', false, $2, $3::jsonb, now())
           RETURNING maintenance_run_id`,
          [operation, options.actor, JSON.stringify({ tables, timeout })]
        );
        maintenanceRunId = inserted.rows[0]!.maintenance_run_id;
        await client.query(
          "SELECT set_config('statement_timeout', $1, false)",
          [`${timeout}ms`]
        );
        const settings = (
          await client.query<Record<string, string>>(`
            SELECT
              current_setting('server_version') AS server_version,
              current_setting('maintenance_work_mem') AS maintenance_work_mem,
              current_setting('max_parallel_maintenance_workers') AS max_parallel_maintenance_workers,
              current_setting('dynamic_shared_memory_type') AS dynamic_shared_memory_type,
              current_setting('statement_timeout') AS statement_timeout
          `)
        ).rows[0] ?? {};
        for (const table of tables) {
          const quoted = `"${table}"`;
          await client.query(
            operation === "analyze"
              ? `ANALYZE public.${quoted}`
              : `VACUUM (ANALYZE) public.${quoted}`
          );
        }
        const result: MaintenanceResult = {
          operation,
          tables,
          settings,
          status: "succeeded"
        };
        await client.query(
          `UPDATE storage_maintenance_run
              SET status = 'succeeded',
                  finished_at = now(),
                  result = $2::jsonb
            WHERE maintenance_run_id = $1`,
          [maintenanceRunId, JSON.stringify(result)]
        );
        return result;
      } catch (caught) {
        const error = maintenanceRemediation(caught);
        if (maintenanceRunId) {
          await client
            .query(
              `UPDATE storage_maintenance_run
                  SET status = 'failed',
                      finished_at = now(),
                      error_report = $2::jsonb
                WHERE maintenance_run_id = $1`,
              [
                maintenanceRunId,
                JSON.stringify([{ error: error.message.slice(0, 1000) }])
              ]
            )
            .catch(() => undefined);
        }
        throw error;
      } finally {
        await client
          .query("SELECT set_config('statement_timeout', '0', false)")
          .catch(() => undefined);
        await unlockLifecycle(client);
      }
    }

    export async function withLifecycleClient<T>(
      databaseUrl: string,
      operation: (client: Client) => Promise<T>
    ): Promise<T> {
      const client = new Client({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 10_000,
        query_timeout: 900_000
      });
      try {
        await client.connect();
        return await operation(client);
      } catch (error) {
        if (
          error instanceof Error &&
          !("code" in error) &&
          !error.message.includes("PostgreSQL")
        ) {
          throw error;
        }
        throw new DatabaseOperationError(classifyDatabaseError(error));
      } finally {
        await client.end().catch(() => undefined);
      }
    }

async function finishPurgeExecution(
  client: Client,
  stored: {
    maintenanceRunId: string;
    status: string;
    plan: PurgePlan;
    actor: string;
    expectedRemainingToken: string | null;
  },
  batchSize: number,
  maxRows: number,
  maxRuntimeMs: number,
  started: number,
  deleted: Record<string, number>,
  initialPrimaryDeleted: number
): Promise<PurgeExecutionResult> {
    let primaryDeleted = initialPrimaryDeleted;
    await client.query(
      `UPDATE storage_maintenance_run
          SET status = 'running',
              dry_run = false,
              started_at = coalesce(started_at, now())
        WHERE maintenance_run_id = $1`,
      [stored.maintenanceRunId]
    );
    const cutoff = new Date(stored.plan.cutoff);
    const runners =
      stored.plan.operation === "stale_purge"
        ? [
            deleteChunkBatch,
            deletePageBatch,
            deleteDocumentVersionBatch,
            deleteOrphanLocatorBatch
          ]
        : [deleteAuditBatch];
    for (const runner of runners) {
      while (
        primaryDeleted < maxRows &&
        Date.now() - started < maxRuntimeMs
      ) {
        const remaining = Math.min(batchSize, maxRows - primaryDeleted);
        const batch = await runner(client, cutoff, remaining);
        addDeleted(deleted, batch.deleted);
        primaryDeleted += batch.primaryRows;
        if (batch.primaryRows === 0) break;
      }
      if (
        primaryDeleted >= maxRows ||
        Date.now() - started >= maxRuntimeMs
      ) {
        break;
      }
    }
    const remainingPlan =
      stored.plan.operation === "stale_purge"
        ? await stalePlanAt(
            client,
            stored.plan.retentionDays,
            new Date(stored.plan.requestedAt)
          )
        : await auditPlanAt(client, new Date(stored.plan.requestedAt));
    const remainingEligibleRows = remainingPlan.totalRows;
    const status = remainingEligibleRows === 0 ? "succeeded" : "partial";
    const result: PurgeExecutionResult = {
      maintenanceRunId: stored.maintenanceRunId,
      operation: stored.plan.operation,
      status,
      deleted,
      logicalBytesEstimate: logicalBytesForDeleted(stored.plan, deleted),
      remainingEligibleRows,
      elapsedMs: Date.now() - started
    };
    const persistedResult = {
      ...result,
      remainingPlanToken: confirmationToken(remainingPlan)
    };
    await client.query(
      `UPDATE storage_maintenance_run
          SET status = $2,
              finished_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE NULL END,
              result = $3::jsonb
        WHERE maintenance_run_id = $1`,
      [stored.maintenanceRunId, status, JSON.stringify(persistedResult)]
    );
    return result;
}
