import { createHash } from "node:crypto";
import type { PdfChunkPlan } from "./pdf.js";

export type EmbeddingRetrievalMode = "semantic" | "lexical_hash";

export interface EmbeddingDescriptor {
  provider: string;
  model: string;
  version: string;
  dimensions: number;
  retrievalMode: EmbeddingRetrievalMode;
}

export interface EmbeddingProvider {
  readonly descriptor: EmbeddingDescriptor;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ChunkEmbeddingPlan extends EmbeddingDescriptor {
  chunkId: string;
  contentSha256: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

function normalizedTokens(value: string): string[] {
  const words = value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const tokens: string[] = [];
  for (const word of words) {
    tokens.push(`w:${word}`);
    if (word.length >= 2) {
      for (let index = 0; index < word.length - 1; index += 1) {
        tokens.push(`b:${word.slice(index, index + 2)}`);
      }
    }
    if (word.length >= 3) {
      for (let index = 0; index < word.length - 2; index += 1) {
        tokens.push(`t:${word.slice(index, index + 3)}`);
      }
    }
  }
  return tokens;
}

function hashedVector(text: string, dimensions: number): number[] {
  const vector = new Float64Array(dimensions);
  const counts = new Map<string, number>();
  for (const token of normalizedTokens(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of counts) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = (digest[4]! & 1) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * (1 + Math.log(count));
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return Array.from(vector);
  return Array.from(vector, (value) => Math.fround(value / norm));
}

export class HashedKoreanEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: EmbeddingDescriptor;

  constructor(dimensions = 384) {
    if (!Number.isInteger(dimensions) || dimensions < 32 || dimensions > 4096) {
      throw new Error("Hashed embedding dimensions must be an integer from 32 to 4096");
    }
    this.descriptor = {
      provider: "local",
      model: "hashed-korean-token",
      version: `1-d${dimensions}`,
      dimensions,
      retrievalMode: "lexical_hash"
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashedVector(text, this.descriptor.dimensions));
  }
}

interface OpenAiEmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: EmbeddingDescriptor;
  private readonly apiKey: string;

  constructor(options: {
    apiKey: string;
    model?: string;
    version?: string;
    dimensions?: number;
    allowExternal: boolean;
  }) {
    if (!options.allowExternal) {
      throw new Error(
        "OpenAI embedding requires the explicit --allow-external flag because document text leaves the machine"
      );
    }
    if (!options.apiKey) throw new Error("OPENAI_API_KEY is required for OpenAI embeddings");
    const dimensions = options.dimensions ?? 1536;
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) {
      throw new Error("OpenAI embedding dimensions must be an integer from 1 to 4096");
    }
    this.apiKey = options.apiKey;
    this.descriptor = {
      provider: "openai",
      model: options.model ?? "text-embedding-3-small",
      version: options.version ?? `api-v1-d${dimensions}`,
      dimensions,
      retrievalMode: "semantic"
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.descriptor.model,
        input: texts,
        dimensions: this.descriptor.dimensions,
        encoding_format: "float"
      })
    });
    if (!response.ok) {
      throw new Error(`OpenAI embedding request failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as OpenAiEmbeddingResponse;
    const ordered = [...(payload.data ?? [])].sort(
      (left, right) => (left.index ?? 0) - (right.index ?? 0)
    );
    if (
      ordered.length !== texts.length ||
      ordered.some(
        (row) => row.embedding?.length !== this.descriptor.dimensions
      )
    ) {
      throw new Error("OpenAI embedding response count or dimensions did not match the request");
    }
    return ordered.map((row) => row.embedding!);
  }
}

export function createEmbeddingProvider(options: {
  provider?: string;
  allowExternal?: boolean;
} = {}): EmbeddingProvider {
  const provider = options.provider ?? "hashed";
  if (provider === "hashed" || provider === "local") {
    const dimensions = Number(process.env.HASHED_EMBEDDING_DIMENSIONS ?? 384);
    return new HashedKoreanEmbeddingProvider(dimensions);
  }
  if (provider === "openai") {
    return new OpenAiEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY ?? "",
      model: process.env.OPENAI_EMBEDDING_MODEL,
      version: process.env.OPENAI_EMBEDDING_VERSION,
      dimensions: Number(process.env.OPENAI_EMBEDDING_DIMENSIONS ?? 1536),
      allowExternal: options.allowExternal === true
    });
  }
  throw new Error(`Unsupported embedding provider: ${provider}`);
}

export function embeddingIdentity(descriptor: EmbeddingDescriptor): string {
  return [
    descriptor.provider,
    descriptor.model,
    descriptor.version,
    descriptor.dimensions
  ].join(":");
}

export async function embedChangedChunks(
  provider: EmbeddingProvider,
  chunks: PdfChunkPlan[],
  existingContentHashes: Map<string, string>,
  options: {
    batchSize?: number;
    onProgress?: (progress: { generated: number; skipped: number; total: number }) => void;
  } = {}
): Promise<{ embeddings: ChunkEmbeddingPlan[]; skipped: number }> {
  const batchSize = options.batchSize ?? 64;
  const changed = chunks.filter(
    (chunk) =>
      chunk.content.trim().length > 0 &&
      existingContentHashes.get(chunk.chunkId) !== chunk.contentSha256
  );
  const skipped = chunks.length - changed.length;
  const embeddings: ChunkEmbeddingPlan[] = [];
  for (let offset = 0; offset < changed.length; offset += batchSize) {
    const batch = changed.slice(offset, offset + batchSize);
    const vectors = await provider.embed(batch.map((chunk) => chunk.content));
    if (vectors.length !== batch.length) {
      throw new Error("Embedding provider returned a different number of vectors");
    }
    for (let index = 0; index < batch.length; index += 1) {
      const chunk = batch[index]!;
      const embedding = vectors[index]!;
      if (embedding.length !== provider.descriptor.dimensions) {
        throw new Error(
          `Embedding dimension mismatch for chunk ${chunk.chunkKey}: expected ${provider.descriptor.dimensions}, received ${embedding.length}`
        );
      }
      embeddings.push({
        ...provider.descriptor,
        chunkId: chunk.chunkId,
        contentSha256: chunk.contentSha256,
        embedding,
        metadata: {
          deterministic: provider.descriptor.provider === "local",
          retrievalOnly: provider.descriptor.retrievalMode === "lexical_hash"
        }
      });
    }
    options.onProgress?.({
      generated: embeddings.length,
      skipped,
      total: chunks.length
    });
  }
  if (changed.length === 0) {
    options.onProgress?.({ generated: 0, skipped, total: chunks.length });
  }
  return { embeddings, skipped };
}
