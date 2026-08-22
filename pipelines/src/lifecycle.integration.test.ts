import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  approveProcessingVersion,
  createPurgePlan,
  executePurge,
  LIFECYCLE_LOCK_KEYS,
  retireProcessingVersion
} from "./lifecycle.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe.sequential : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actor = "integration:lifecycle";
let client: Client;

async function cleanupFixture(): Promise<void> {
  await client.query(
    "DELETE FROM mcp_tool_audit WHERE tool_name = $1",
    [`lifecycle-fixture-${suffix}`]
  );
  await client.query(
    "DELETE FROM mcp_tool_audit_daily WHERE tool_name = $1",
    [`lifecycle-fixture-${suffix}`]
  );
  await client.query(
    "DELETE FROM storage_maintenance_run WHERE requested_by = $1",
    [actor]
  );
  await client.query(
    "DELETE FROM document WHERE document_key = $1",
    [`lifecycle-document-${suffix}`]
  );
  await client.query(
    "DELETE FROM data_source WHERE source_key = $1",
    [`lifecycle-source-${suffix}`]
  );
  await client.query(
    "DELETE FROM pdf_processing_version_event WHERE version_key = ANY($1::text[])",
    [[
      `lifecycle-extractor-${suffix}::lifecycle-chunker-${suffix}`,
      `lifecycle-candidate-extractor-${suffix}::lifecycle-candidate-chunker-${suffix}`
    ]]
  );
  await client.query(
    "DELETE FROM pdf_processing_version WHERE version_key = ANY($1::text[])",
    [[
      `lifecycle-extractor-${suffix}::lifecycle-chunker-${suffix}`,
      `lifecycle-candidate-extractor-${suffix}::lifecycle-candidate-chunker-${suffix}`
    ]]
  );
}

async function insertStaleFixture(): Promise<{
  versionKey: string;
  sourceId: string;
  documentId: string;
}> {
  const versionKey =
    `lifecycle-extractor-${suffix}::lifecycle-chunker-${suffix}`;
  const sourceId = randomUUID();
  const documentId = randomUUID();
  const pageId = randomUUID();
  const oldTimestamp = "2020-01-01T00:00:00.000Z";
  await client.query(
    `INSERT INTO pdf_processing_version
      (
        version_key, extractor_version, chunker_version, approval_state,
        retired_at, retired_by, retirement_reason
      )
     VALUES ($1, $2, $3, 'retired', $4, $5, $6)`,
    [
      versionKey,
      `lifecycle-extractor-${suffix}`,
      `lifecycle-chunker-${suffix}`,
      oldTimestamp,
      actor,
      "Controlled integration purge fixture"
    ]
  );
  await client.query(
    `INSERT INTO data_source
      (
        source_id, source_key, title, provider, file_path, file_sha256,
        collected_at, media_type, data_status, is_official
      )
     VALUES ($1, $2, $3, 'integration-test', $4, $5, $6, 'application/pdf',
       'official_observed', true)`,
    [
      sourceId,
      `lifecycle-source-${suffix}`,
      "Lifecycle purge fixture",
      `fixtures/lifecycle-${suffix}.pdf`,
      "a".repeat(64),
      oldTimestamp
    ]
  );
  await client.query(
    `INSERT INTO document
      (
        document_id, document_key, document_type, title, source_id,
        extraction_status, page_count, content_sha256, data_status
      )
     VALUES ($1, $2, 'council_minutes', $3, $4, 'extracted', 1, $5,
       'official_observed')`,
    [
      documentId,
      `lifecycle-document-${suffix}`,
      "Lifecycle purge fixture",
      sourceId,
      "b".repeat(64)
    ]
  );
  await client.query(
    `INSERT INTO document_processing_version
      (
        document_id, version_key, extraction_status, page_count,
        content_sha256, data_status, created_at, stale_at
      )
     VALUES ($1, $2, 'extracted', 1, $3, 'official_observed', $4, $4)`,
    [documentId, versionKey, "b".repeat(64), oldTimestamp]
  );
  await client.query(
    `INSERT INTO document_page
      (
        page_id, page_key, document_id, page_number, extraction_status,
        raw_content_sha256, content_sha256, extractor_version,
        non_whitespace_character_count, hangul_ratio,
        replacement_control_glyph_ratio, suspicious_spacing_ratio,
        likely_table_density, text_class, is_current, created_at, stale_at
      )
     VALUES ($1, $2, $3, 1, 'extracted', $4, $5, $6, 10, 0.5, 0, 0, 0,
       'substantive', false, $7, $7)`,
    [
      pageId,
      `lifecycle-page-${suffix}`,
      documentId,
      "c".repeat(64),
      "d".repeat(64),
      `lifecycle-extractor-${suffix}`,
      oldTimestamp
    ]
  );
  await client.query(
    `INSERT INTO source_locator
      (source_id, entity_type, entity_key, page_number, locator_text, created_at)
     VALUES ($1, 'document_page', $2, 1, 'controlled page', $3)`,
    [sourceId, `lifecycle-page-${suffix}`, oldTimestamp]
  );
  for (let index = 0; index < 2; index += 1) {
    const chunkId = randomUUID();
    const chunkKey = `lifecycle-chunk-${suffix}-${index}`;
    const contentHash = index === 0 ? "e".repeat(64) : "f".repeat(64);
    await client.query(
      `INSERT INTO document_chunk
        (
          chunk_id, chunk_key, document_id, chunk_index, page_start, page_end,
          content, content_sha256, token_count, processing_version_key,
          is_current, approved_current, created_at, stale_at
        )
       VALUES ($1, $2, $3, $4, 1, 1, $5, $6, 2, $7, false, false, $8, $8)`,
      [
        chunkId,
        chunkKey,
        documentId,
        index,
        `의회 fixture ${index}`,
        contentHash,
        versionKey,
        oldTimestamp
      ]
    );
    await client.query(
      `INSERT INTO document_chunk_embedding
        (
          chunk_id, provider, model, model_version, dimensions,
          retrieval_mode, embedding, content_sha256
        )
       VALUES ($1, 'local', 'fixture', '1', 4, 'lexical_hash',
         $2::real[], $3)`,
      [chunkId, [1, 0, 0, index], contentHash]
    );
    await client.query(
      `INSERT INTO source_locator
        (source_id, entity_type, entity_key, page_number, locator_text, created_at)
       VALUES ($1, 'document_chunk', $2, 1, 'controlled chunk', $3)`,
      [sourceId, chunkKey, oldTimestamp]
    );
  }
  return { versionKey, sourceId, documentId };
}

describeDatabase("source lifecycle integration", () => {
  beforeAll(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await cleanupFixture();
  });

  afterAll(async () => {
    if (!client) return;
    await cleanupFixture().catch(() => undefined);
    await client.end();
  });

  it("protects the measured retained corpus with the minimum age", async () => {
    const counts = (
      await client.query<{
        current_chunks: string;
        stale_chunks: string;
        current_embeddings: string;
        current_pages: string;
        current_page_locators: string;
      }>(`
        SELECT
          (SELECT count(*) FROM document_chunk WHERE is_current)::text
            AS current_chunks,
          (SELECT count(*) FROM document_chunk WHERE NOT is_current)::text
            AS stale_chunks,
          (
            SELECT count(*)
              FROM document_chunk_embedding embedding
              JOIN document_chunk chunk ON chunk.chunk_id = embedding.chunk_id
             WHERE chunk.is_current
          )::text AS current_embeddings,
          (SELECT count(*) FROM document_page WHERE is_current)::text
            AS current_pages,
          (
            SELECT count(*)
              FROM source_locator locator
              JOIN document_page page
                ON locator.entity_type = 'document_page'
               AND locator.entity_key = page.page_key
             WHERE page.is_current
          )::text AS current_page_locators
      `)
    ).rows[0]!;
    expect(Number(counts.current_chunks)).toBe(23_795);
    expect(Number(counts.stale_chunks)).toBe(17_487);
    expect(Number(counts.current_embeddings)).toBe(23_795);
    expect(Number(counts.current_pages)).toBe(11_712);
    expect(Number(counts.current_page_locators)).toBe(11_712);

    const planned = await createPurgePlan(client, {
      operation: "stale_purge",
      retentionDays: 30,
      minimumRetentionDays: 30,
      actor
    });
    expect(planned.plan.entities.chunks?.count).toBe(0);
    expect(planned.plan.totalRows).toBe(0);
  });

  it(
    "purges a controlled retired fixture in FK-safe resumable batches",
    async () => {
      const fixture = await insertStaleFixture();
      const planned = await createPurgePlan(client, {
        operation: "stale_purge",
        retentionDays: 30,
        minimumRetentionDays: 30,
        actor,
        now: new Date("2026-08-22T00:00:00.000Z")
      });
      expect(planned.plan.entities.chunks?.count).toBe(2);
      expect(planned.plan.entities.embeddings?.count).toBe(2);
      expect(planned.plan.entities.pages?.count).toBe(1);
      expect(planned.plan.entities.documentVersions?.count).toBe(1);

      const first = await executePurge(client, planned.token, {
        batchSize: 1,
        maxRows: 1,
        maxRuntimeMs: 10_000
      });
      expect(first.status).toBe("partial");
      expect(first.deleted).toMatchObject({
        chunks: 1,
        embeddings: 1,
        chunkLocators: 1
      });

      let result = first;
      for (
        let attempt = 0;
        attempt < 5 && result.status === "partial";
        attempt += 1
      ) {
        result = await executePurge(client, planned.token, {
          batchSize: 1,
          maxRows: 1,
          maxRuntimeMs: 10_000
        });
      }
      expect(result.status).toBe("succeeded");
      const remaining = await client.query<{ value: string }>(
        `SELECT (
           (SELECT count(*) FROM document_chunk WHERE document_id = $1)
           + (SELECT count(*) FROM document_page WHERE document_id = $1)
           + (SELECT count(*) FROM document_processing_version WHERE document_id = $1)
         )::text AS value`,
        [fixture.documentId]
      );
      expect(Number(remaining.rows[0]!.value)).toBe(0);
      expect(
        await client.query(
          `SELECT 1
             FROM source_locator
            WHERE source_id = $1
              AND entity_type IN ('document_chunk', 'document_page')`,
          [fixture.sourceId]
        )
      ).toHaveProperty("rowCount", 0);
    },
    60_000
  );

  it("aggregates and purges expired audit rows in resumable batches", async () => {
    const toolName = `lifecycle-fixture-${suffix}`;
    for (let index = 0; index < 2; index += 1) {
      await client.query(
        `INSERT INTO mcp_tool_audit
          (
            tool_name, started_at, finished_at, duration_ms, success,
            data_statuses, result_count, request_hash, request_metadata,
            repository_mode, created_at, expires_at
          )
         VALUES ($1, $2, $2, $3, true, ARRAY['official_observed'], $4, $5,
           '{}'::jsonb, 'postgres', $2, $2)`,
        [
          toolName,
          "2020-01-01T00:00:00.000Z",
          10 + index,
          index + 1,
          String(index).repeat(64)
        ]
      );
    }
    const planned = await createPurgePlan(client, {
      operation: "audit_purge",
      actor,
      now: new Date("2026-08-22T00:00:00.000Z")
    });
    expect(planned.plan.entities.audits?.count).toBe(2);
    const first = await executePurge(client, planned.token, {
      batchSize: 1,
      maxRows: 1
    });
    expect(first.status).toBe("partial");
    const second = await executePurge(client, planned.token, {
      batchSize: 1,
      maxRows: 1
    });
    expect(second.status).toBe("succeeded");
    const aggregate = await client.query<{
      call_count: string;
      result_count_sum: string;
    }>(
      `SELECT call_count::text, result_count_sum::text
         FROM mcp_tool_audit_daily
        WHERE tool_name = $1`,
      [toolName]
    );
    expect(aggregate.rows[0]).toMatchObject({
      call_count: "2",
      result_count_sum: "3"
    });
  });

  it("invalidates a partial plan when its remaining candidates change", async () => {
    const toolName = `lifecycle-fixture-${suffix}`;
    const insertAudit = async (requestHash: string): Promise<void> => {
      await client.query(
        `INSERT INTO mcp_tool_audit
          (
            tool_name, started_at, finished_at, duration_ms, success,
            data_statuses, result_count, request_hash, request_metadata,
            repository_mode, created_at, expires_at
          )
         VALUES ($1, $2, $2, 1, true, ARRAY['official_observed'], 1, $3,
           '{}'::jsonb, 'postgres', $2, $2)`,
        [toolName, "2020-01-02T00:00:00.000Z", requestHash]
      );
    };
    await insertAudit("a".repeat(64));
    await insertAudit("b".repeat(64));
    const planned = await createPurgePlan(client, {
      operation: "audit_purge",
      actor,
      now: new Date("2026-08-22T00:00:00.000Z")
    });
    const partial = await executePurge(client, planned.token, {
      batchSize: 1,
      maxRows: 1
    });
    expect(partial.status).toBe("partial");

    await insertAudit("c".repeat(64));
    await expect(
      executePurge(client, planned.token, { batchSize: 1, maxRows: 1 })
    ).rejects.toThrow(/candidates changed/);
  });

  it("refuses execution while the lifecycle advisory lock is held", async () => {
    const planned = await createPurgePlan(client, {
      operation: "audit_purge",
      actor
    });
    const lockClient = new Client({ connectionString });
    await lockClient.connect();
    try {
      await lockClient.query("SELECT pg_advisory_lock($1, $2)", [
        ...LIFECYCLE_LOCK_KEYS
      ]);
      await expect(executePurge(client, planned.token)).rejects.toThrow(
        /advisory lock/
      );
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock($1, $2)", [
        ...LIFECYCLE_LOCK_KEYS
      ]);
      await lockClient.end();
    }
  });

  it("retires a candidate without changing approved visibility", async () => {
    const versionKey =
      `lifecycle-candidate-extractor-${suffix}::lifecycle-candidate-chunker-${suffix}`;
    await client.query(
      `INSERT INTO pdf_processing_version
        (version_key, extractor_version, chunker_version, approval_state)
       VALUES ($1, $2, $3, 'candidate')`,
      [
        versionKey,
        `lifecycle-candidate-extractor-${suffix}`,
        `lifecycle-candidate-chunker-${suffix}`
      ]
    );
    const before = (
      await client.query<{ version_key: string }>(
        "SELECT version_key FROM pdf_processing_version WHERE approval_state = 'approved'"
      )
    ).rows[0]!.version_key;
    expect(
      await retireProcessingVersion(
        client,
        versionKey,
        actor,
        "Candidate failed controlled lifecycle evaluation"
      )
    ).toEqual({ versionKey, approvalState: "retired" });
    const after = (
      await client.query<{ version_key: string }>(
        "SELECT version_key FROM pdf_processing_version WHERE approval_state = 'approved'"
      )
    ).rows[0]!.version_key;
    expect(after).toBe(before);
  });

  it(
    "rolls production visibility to retained output and back atomically",
    async () => {
      const active = (
        await client.query<{ version_key: string }>(
          `SELECT version_key
             FROM pdf_processing_version
            WHERE approval_state = 'approved'`
        )
      ).rows[0]!.version_key;
      const retained = (
        await client.query<{ version_key: string }>(
          `SELECT version.version_key
             FROM pdf_processing_version version
            WHERE version.approval_state = 'retired'
              AND (
                SELECT count(*) FROM document_chunk chunk
                 WHERE chunk.processing_version_key = version.version_key
              ) = 17487
            LIMIT 1`
        )
      ).rows[0]!.version_key;
      try {
        const rolledBack = await approveProcessingVersion(
          client,
          retained,
          actor,
          "Integration verification of retained rollback"
        );
        expect(rolledBack).toMatchObject({
          versionKey: retained,
          previousVersion: active,
          action: "rollback",
          currentChunks: 17_487
        });
        await expect(
          retireProcessingVersion(
            client,
            retained,
            actor,
            "Approved version must remain protected"
          )
        ).rejects.toThrow(/Cannot retire the approved version/);
      } finally {
        const selected = (
          await client.query<{ version_key: string }>(
            `SELECT version_key
               FROM pdf_processing_version
              WHERE approval_state = 'approved'`
          )
        ).rows[0]?.version_key;
        if (selected !== active) {
          await approveProcessingVersion(
            client,
            active,
            actor,
            "Restore verified production processing version"
          );
        }
      }
      const restored = await client.query<{
        current_chunks: string;
        current_embeddings: string;
        current_pages: string;
      }>(`
        SELECT
          (SELECT count(*) FROM document_chunk
            WHERE is_current AND approved_current)::text AS current_chunks,
          (
            SELECT count(*)
              FROM document_chunk_embedding embedding
              JOIN document_chunk chunk ON chunk.chunk_id = embedding.chunk_id
             WHERE chunk.is_current AND chunk.approved_current
          )::text AS current_embeddings,
          (SELECT count(*) FROM document_page WHERE is_current)::text
            AS current_pages
      `);
      expect(restored.rows[0]).toMatchObject({
        current_chunks: "23795",
        current_embeddings: "23795",
        current_pages: "11712"
      });
    },
    180_000
  );
});
