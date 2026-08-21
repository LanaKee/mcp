export interface SearchDocument<TMetadata extends Record<string, unknown>> {
  id: string;
  title: string;
  text: string;
  metadata: TMetadata;
}

export interface SearchResult<TMetadata extends Record<string, unknown>>
  extends SearchDocument<TMetadata> {
  score: number;
  matchedTerms: string[];
}

export interface VectorSearchAdapter<TMetadata extends Record<string, unknown>> {
  search(
    query: string,
    documents: SearchDocument<TMetadata>[],
    limit: number
  ): Promise<Array<{ id: string; score: number }>>;
}

export class DisabledVectorAdapter<TMetadata extends Record<string, unknown>>
  implements VectorSearchAdapter<TMetadata>
{
  async search(
    _query: string,
    _documents: SearchDocument<TMetadata>[],
    _limit: number
  ): Promise<Array<{ id: string; score: number }>> {
    return [];
  }
}

export function normalizeKoreanText(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeKorean(value: string): string[] {
  const normalized = normalizeKoreanText(value);
  if (!normalized) return [];
  const words = normalized.split(" ");
  const terms = new Set(words);
  for (const word of words) {
    if (word.length >= 3) {
      for (let index = 0; index < word.length - 1; index += 1) {
        terms.add(word.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}

export interface SearchOptions<TMetadata extends Record<string, unknown>> {
  limit?: number;
  filter?: (metadata: TMetadata) => boolean;
}

export function lexicalSearch<TMetadata extends Record<string, unknown>>(
  query: string,
  documents: SearchDocument<TMetadata>[],
  options: SearchOptions<TMetadata> = {}
): SearchResult<TMetadata>[] {
  const normalizedQuery = normalizeKoreanText(query);
  const queryTerms = tokenizeKorean(query);
  return documents
    .filter((document) => !options.filter || options.filter(document.metadata))
    .map((document) => {
      const title = normalizeKoreanText(document.title);
      const text = normalizeKoreanText(document.text);
      const combined = `${title} ${text}`;
      const matchedTerms = queryTerms.filter((term) => combined.includes(term));
      let score = matchedTerms.reduce(
        (total, term) =>
          total +
          (title.includes(term) ? 4 : 0) +
          (text.includes(term) ? 1 : 0),
        0
      );
      if (title.includes(normalizedQuery)) score += 20;
      if (text.includes(normalizedQuery)) score += 12;
      return { ...document, score, matchedTerms };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, options.limit ?? 5);
}

export async function hybridSearch<TMetadata extends Record<string, unknown>>(
  query: string,
  documents: SearchDocument<TMetadata>[],
  vectorAdapter: VectorSearchAdapter<TMetadata>,
  options: SearchOptions<TMetadata> = {}
): Promise<SearchResult<TMetadata>[]> {
  const filtered = documents.filter(
    (document) => !options.filter || options.filter(document.metadata)
  );
  const lexical = lexicalSearch(query, filtered, { limit: Math.max(options.limit ?? 5, 20) });
  const vectors = await vectorAdapter.search(query, filtered, 20);
  const vectorScores = new Map(vectors.map((result) => [result.id, result.score]));
  const candidates = new Map(lexical.map((result) => [result.id, result]));
  for (const document of filtered) {
    const vectorScore = vectorScores.get(document.id);
    if (vectorScore !== undefined && !candidates.has(document.id)) {
      candidates.set(document.id, { ...document, score: 0, matchedTerms: [] });
    }
  }
  return [...candidates.values()]
    .map((result) => ({
      ...result,
      score: result.score + (vectorScores.get(result.id) ?? 0) * 10
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 5);
}

export interface PostgresEmbeddingSelector {
  provider: string;
  model: string;
  version: string;
  dimensions: number;
}

export interface PostgresHybridSearchInput {
  query: string;
  queryEmbedding?: number[] | null;
  embedding: PostgresEmbeddingSelector;
  regionId?: string;
  publishedFrom?: string;
  publishedTo?: string;
  limit?: number;
  candidateLimit?: number;
}

export interface ParameterizedQuery {
  text: string;
  values: unknown[];
}

export interface PostgresHybridSearchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  page_start: number;
  page_end: number;
  source_id: string;
  file_path: string | null;
  lexical_score: number | string;
  vector_score: number | string | null;
  combined_score: number | string;
}

export interface PostgresQueryClient {
  query<T>(
    text: string,
    values: unknown[]
  ): Promise<{ rows: T[] }>;
}

export function buildPostgresHybridSearchQuery(
  input: PostgresHybridSearchInput
): ParameterizedQuery {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const candidateLimit = Math.min(
    Math.max(input.candidateLimit ?? Math.max(limit * 20, 200), limit),
    2000
  );
  const ftsQuery = normalizeKoreanText(input.query)
    .split(" ")
    .filter(Boolean)
    .join(" | ");
  if (!ftsQuery) throw new Error("Search query must contain letters or numbers");
  if (
    input.queryEmbedding &&
    input.queryEmbedding.length !== input.embedding.dimensions
  ) {
    throw new Error("Query embedding dimensions do not match the selected model");
  }
  return {
    text: `
      WITH candidate_ids AS MATERIALIZED (
        SELECT chunk_id
        FROM document_chunk
        WHERE is_current
          AND to_tsvector('simple', content) @@ to_tsquery('simple', $14)
        UNION
        SELECT chunk_id
        FROM document_chunk
        WHERE is_current
          AND content ILIKE ('%' || $1 || '%')
        UNION
        SELECT dc.chunk_id
        FROM document d
        JOIN document_chunk dc ON dc.document_id = d.document_id
        WHERE dc.is_current
          AND coalesce(d.title, '') % $1
      ),
      raw_candidates AS (
        SELECT
          dc.chunk_id,
          dc.document_id,
          d.title,
          dc.content,
          dc.page_start,
          dc.page_end,
          ds.source_id,
          ds.file_path,
          (
            ts_rank(
              to_tsvector('simple', dc.content),
              to_tsquery('simple', $14)
            ) * 4
            + similarity(coalesce(d.title, ''), $1) * 2
            + similarity(dc.content, $1)
          )::double precision AS lexical_score,
          e.embedding
        FROM candidate_ids candidate
        JOIN document_chunk dc ON dc.chunk_id = candidate.chunk_id
        JOIN document d ON d.document_id = dc.document_id
        JOIN data_source ds ON ds.source_id = d.source_id
        LEFT JOIN document_chunk_embedding e
          ON e.chunk_id = dc.chunk_id
         AND e.provider = $3
         AND e.model = $4
         AND e.model_version = $5
         AND e.dimensions = $6
        WHERE ($8::text IS NULL OR d.region_id = $8)
          AND ($9::date IS NULL OR d.published_date >= $9)
          AND ($10::date IS NULL OR d.published_date <= $10)
      ),
      candidates AS (
        SELECT *
        FROM raw_candidates
        ORDER BY lexical_score DESC, chunk_id
        LIMIT $13
      ),
      scored AS (
        SELECT
          candidates.*,
          vector.score AS vector_score
        FROM candidates
        LEFT JOIN LATERAL (
          SELECT
            sum(stored.value * query.value)
            / NULLIF(
                sqrt(sum(stored.value * stored.value))
                * sqrt(sum(query.value * query.value)),
                0
              ) AS score
          FROM unnest(candidates.embedding) WITH ORDINALITY AS stored(value, index)
          JOIN unnest($2::real[]) WITH ORDINALITY AS query(value, index)
            USING (index)
          WHERE $2::real[] IS NOT NULL
            AND cardinality(candidates.embedding) = cardinality($2::real[])
        ) vector ON candidates.embedding IS NOT NULL
      )
      SELECT
        chunk_id::text,
        document_id::text,
        title,
        content,
        page_start,
        page_end,
        source_id::text,
        file_path,
        lexical_score,
        vector_score,
        (
          lexical_score * $11::double precision
          + coalesce(vector_score, 0) * $12::double precision
        ) AS combined_score
      FROM scored
      WHERE lexical_score > 0 OR vector_score IS NOT NULL
      ORDER BY combined_score DESC, chunk_id
      LIMIT $7
    `,
    values: [
      input.query,
      input.queryEmbedding ?? null,
      input.embedding.provider,
      input.embedding.model,
      input.embedding.version,
      input.embedding.dimensions,
      limit,
      input.regionId ?? null,
      input.publishedFrom ?? null,
      input.publishedTo ?? null,
      0.65,
      0.35,
      candidateLimit,
      ftsQuery
    ]
  };
}

export class PostgresHybridSearchRepository {
  constructor(private readonly client: PostgresQueryClient) {}

  async search(input: PostgresHybridSearchInput): Promise<
    Array<{
      chunkId: string;
      documentId: string;
      title: string;
      content: string;
      pageStart: number;
      pageEnd: number;
      sourceId: string;
      filePath: string | null;
      lexicalScore: number;
      vectorScore: number | null;
      score: number;
    }>
  > {
    const query = buildPostgresHybridSearchQuery(input);
    const result = await this.client.query<PostgresHybridSearchRow>(
      query.text,
      query.values
    );
    return result.rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      title: row.title,
      content: row.content,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      sourceId: row.source_id,
      filePath: row.file_path,
      lexicalScore: Number(row.lexical_score),
      vectorScore:
        row.vector_score === null ? null : Number(row.vector_score),
      score: Number(row.combined_score)
    }));
  }
}
