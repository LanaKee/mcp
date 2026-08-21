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

