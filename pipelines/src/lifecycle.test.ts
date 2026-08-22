import { describe, expect, it } from "vitest";
import {
  capacityWarnings,
  confirmationToken,
  enforceRetentionDays,
  processingVersionKey,
  validateActorReason,
  validateConfirmationToken,
  validateMaintenanceTables,
  type PurgePlan
} from "./lifecycle.js";

function plan(): PurgePlan {
  return {
    operation: "stale_purge",
    requestedAt: "2026-08-22T00:00:00.000Z",
    cutoff: "2026-07-23T00:00:00.000Z",
    retentionDays: 30,
    approvedVersion: "extractor::chunker-v3",
    entities: {
      chunks: {
        count: 2,
        logicalBytes: 1000,
        contentHash: "a".repeat(64)
      },
      embeddings: {
        count: 2,
        logicalBytes: 3000,
        contentHash: "b".repeat(64)
      }
    },
    totalRows: 4,
    logicalBytes: 4000
  };
}

describe("source lifecycle safety", () => {
  it("binds confirmation tokens to the exact canonical purge plan", () => {
    const value = plan();
    const token = confirmationToken(value);
    expect(validateConfirmationToken(value, token)).toBe(true);
    expect(
      validateConfirmationToken(
        { ...value, retentionDays: 31 },
        token
      )
    ).toBe(false);
    expect(validateConfirmationToken(value, "0".repeat(64))).toBe(false);
  });

  it("enforces minimum retention and bounded actor/reason fields", () => {
    expect(enforceRetentionDays(30, 30)).toBe(30);
    expect(() => enforceRetentionDays(29, 30)).toThrow(/30 to 3650/);
    expect(() => enforceRetentionDays(30.5, 30)).toThrow();
    expect(() => validateActorReason("a", "valid reason")).toThrow();
    expect(() => validateActorReason("operator", "bad")).toThrow();
    expect(() =>
      validateActorReason("operator", "Approved after corpus verification")
    ).not.toThrow();
  });

  it("rejects arbitrary maintenance table identifiers", () => {
    expect(
      validateMaintenanceTables(["document_chunk", "document_page"])
    ).toEqual(["document_chunk", "document_page"]);
    expect(() =>
      validateMaintenanceTables(["document_chunk; DROP TABLE document"])
    ).toThrow(/selected from/);
  });

  it("reports bounded capacity threshold warnings", () => {
    const warnings = capacityWarnings(
      {
        currentChunks: 100,
        staleChunks: 50,
        approvedCurrentChunks: 99,
        currentEmbeddings: 100,
        staleEmbeddings: 50,
        currentPages: 10,
        stalePages: 0,
        documentVersions: 2,
        orphanDocumentLocators: 0,
        auditRows: 20,
        expiredAuditRows: 11
      },
      {
        databaseBytes: 2000,
        relations: {}
      },
      {
        staleRatioPercent: 25,
        databaseBytes: 1500,
        embeddingRows: 120,
        expiredAuditRows: 10
      }
    );
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("stale_chunk_ratio"),
        expect.stringContaining("database_bytes"),
        expect.stringContaining("embedding_rows"),
        expect.stringContaining("expired_audit_rows"),
        "unapproved_current_chunks:1"
      ])
    );
  });

  it("requires chunker identity changes when processing identity changes", () => {
    expect(processingVersionKey("extractor-v2", "chunker-v3")).toBe(
      "extractor-v2::chunker-v3"
    );
    expect(() => processingVersionKey("", "chunker")).toThrow();
  });
});
