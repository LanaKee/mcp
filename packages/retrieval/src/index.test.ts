import { describe, expect, it } from "vitest";
import {
  buildPostgresHybridSearchQuery,
  lexicalSearch,
  normalizeKoreanText,
  PostgresHybridSearchRepository,
  tokenizeKorean
} from "./index.js";

const documents = [
  {
    id: "2021",
    title: "지방소멸 대응 특별위원회",
    text: "청년 정착과 일자리 대책을 논의하였다.",
    metadata: { region: "경상북도", date: "2021-03-01", council: "도의회" }
  },
  {
    id: "2024",
    title: "농촌 스마트팜 지원",
    text: "스마트 농업과 청년 창업을 지원한다.",
    metadata: { region: "상주시", date: "2024-05-01", council: "시의회" }
  }
];

describe("Korean lexical retrieval", () => {
  it("normalizes NFD Hangul", () => {
    expect(normalizeKoreanText("지방소멸")).toBe("지방소멸");
  });

  describe("PostgreSQL hybrid retrieval", () => {
    it("builds parameterized lexical and vector-array scoring SQL", () => {
      const query = buildPostgresHybridSearchQuery({
        query: "청년 정착",
        queryEmbedding: [0.5, -0.5],
        embedding: {
          provider: "local",
          model: "hashed-korean-token",
          version: "1-d2",
          dimensions: 2
        },
        regionId: "47",
        limit: 5
      });
      expect(query.text).toContain("document_chunk_embedding");
      expect(query.text).toContain("candidate_ids AS MATERIALIZED");
      expect(query.text).toContain("unnest(candidates.embedding)");
      expect(query.text).not.toContain("청년 정착");
      expect(query.values.slice(0, 8)).toEqual([
        "청년 정착",
        [0.5, -0.5],
        "local",
        "hashed-korean-token",
        "1-d2",
        2,
        5,
        "47"
      ]);
    });

    it("maps repository scores without replacing the in-memory path", async () => {
      const repository = new PostgresHybridSearchRepository({
        async query() {
          return {
            rows: [
              {
                chunk_id: "chunk",
                document_id: "document",
                title: "지방소멸 대응",
                content: "청년 정착 지원",
                page_start: 3,
                page_end: 3,
                source_id: "source",
                file_path: "datasets/a.pdf",
                region_name: "김천시",
                organization: "김천시의회",
                published_date: "2023-01-01",
                data_status: "official_observed",
                lexical_score: "1.25",
                vector_score: "0.5",
                combined_score: "0.9875"
              }
            ]
          };
        }
      });
      const rows = await repository.search({
        query: "청년",
        embedding: {
          provider: "local",
          model: "hashed-korean-token",
          version: "1-d384",
          dimensions: 384
        }
      });
      expect(rows[0]).toMatchObject({
        chunkId: "chunk",
        pageStart: 3,
        lexicalScore: 1.25,
        vectorScore: 0.5,
        score: 0.9875
      });
    });
  });

  it("adds Hangul bigrams for partial matching", () => {
    expect(tokenizeKorean("지방소멸")).toContain("소멸");
  });

  it("supports substring ranking and metadata filters", () => {
    const result = lexicalSearch("지방소멸 청년", documents, {
      filter: (metadata) => metadata.council === "도의회"
    });
    expect(result.map((item) => item.id)).toEqual(["2021"]);
  });
});
