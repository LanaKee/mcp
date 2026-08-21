import { describe, expect, it } from "vitest";
import {
  embedChangedChunks,
  HashedKoreanEmbeddingProvider,
  OpenAiEmbeddingProvider
} from "./embeddings.js";
import type { PdfChunkPlan } from "./pdf.js";

const chunk: PdfChunkPlan = {
  chunkId: "00000000-0000-5000-8000-000000000001",
  chunkKey: "document:page:1:chunk:0",
  documentId: "00000000-0000-5000-8000-000000000002",
  chunkIndex: 0,
  pageStart: 1,
  pageEnd: 1,
  sectionTitle: null,
  content: "경상북도 청년 정착과 지방소멸 대응",
  contentSha256: "b".repeat(64),
  tokenCount: 5,
  metadata: {}
};

describe("local embedding provider", () => {
  it("generates deterministic normalized Korean token vectors", async () => {
    const provider = new HashedKoreanEmbeddingProvider(64);
    const [first, second] = await provider.embed([chunk.content, chunk.content]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(64);
    const norm = Math.sqrt(first!.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(provider.descriptor.retrievalMode).toBe("lexical_hash");
  });

  it("skips unchanged hashes and never embeds empty text", async () => {
    const provider = new HashedKoreanEmbeddingProvider(64);
    const empty = { ...chunk, chunkId: "00000000-0000-5000-8000-000000000003", content: "" };
    const result = await embedChangedChunks(
      provider,
      [chunk, empty],
      new Map([[chunk.chunkId, chunk.contentSha256]])
    );
    expect(result.embeddings).toEqual([]);
    expect(result.skipped).toBe(2);
  });

  it("refuses external embedding unless explicitly enabled", () => {
    expect(
      () =>
        new OpenAiEmbeddingProvider({
          apiKey: "not-used",
          allowExternal: false
        })
    ).toThrow(/allow-external/);
  });
});
