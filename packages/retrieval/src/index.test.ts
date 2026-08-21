import { describe, expect, it } from "vitest";
import { lexicalSearch, normalizeKoreanText, tokenizeKorean } from "./index.js";

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

