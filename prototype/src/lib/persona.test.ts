import { describe, expect, it } from "vitest";
import { composeQuestion, personaLabel, personaSchema } from "./persona";

describe("persona", () => {
  it("맥락을 접두어로 붙인다", () => {
    const persona = personaSchema.parse({ region: "상주시", age: "34", interest: "스마트팜 · 창업" });
    expect(composeQuestion(persona, "나한테 해당되는 게 뭐가 있어?")).toBe(
      "[34세 · 상주시 · 스마트팜 · 창업] 나한테 해당되는 게 뭐가 있어?"
    );
  });

  it("맥락이 비어 있으면 질문을 그대로 보낸다", () => {
    expect(composeQuestion(personaSchema.parse({}), "인구 추세")).toBe("인구 추세");
  });

  it("에이전트 API 상한인 500자를 넘기지 않는다", () => {
    const persona = personaSchema.parse({ region: "상주시", age: "34" });
    expect(composeQuestion(persona, "가".repeat(600))).toHaveLength(500);
  });

  it("빈 항목은 라벨에서 빠진다", () => {
    expect(personaLabel(personaSchema.parse({ region: "포항시" }))).toBe("포항시");
  });
});
