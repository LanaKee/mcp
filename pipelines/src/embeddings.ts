import { hashedKoreanEmbedding } from "@gb/retrieval";
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
    return texts.map((text) =>
      hashedKoreanEmbedding(text, this.descriptor.dimensions)
    );
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
    onBatch?: (embeddings: ChunkEmbeddingPlan[]) => Promise<void>;
    collect?: boolean;
  } = {}
): Promise<{
  embeddings: ChunkEmbeddingPlan[];
  generated: number;
  skipped: number;
}> {
  const batchSize =
    options.batchSize ?? (provider.descriptor.provider === "local" ? 256 : 64);
  const changed = chunks.filter(
    (chunk) =>
      chunk.content.trim().length > 0 &&
      existingContentHashes.get(chunk.chunkId) !== chunk.contentSha256
  );
  const skipped = chunks.length - changed.length;
  const embeddings: ChunkEmbeddingPlan[] = [];
  let generated = 0;
  for (let offset = 0; offset < changed.length; offset += batchSize) {
    const batch = changed.slice(offset, offset + batchSize);
    const vectors = await provider.embed(batch.map((chunk) => chunk.content));
    if (vectors.length !== batch.length) {
      throw new Error("Embedding provider returned a different number of vectors");
    }
    const batchPlans: ChunkEmbeddingPlan[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const chunk = batch[index]!;
      const embedding = vectors[index]!;
      if (embedding.length !== provider.descriptor.dimensions) {
        throw new Error(
          `Embedding dimension mismatch for chunk ${chunk.chunkKey}: expected ${provider.descriptor.dimensions}, received ${embedding.length}`
        );
      }
      batchPlans.push({
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
    await options.onBatch?.(batchPlans);
    generated += batchPlans.length;
    if (options.collect !== false) embeddings.push(...batchPlans);
    options.onProgress?.({
      generated,
      skipped,
      total: chunks.length
    });
  }
  if (changed.length === 0) {
    options.onProgress?.({ generated: 0, skipped, total: chunks.length });
  }
  return { embeddings, generated, skipped };
}
