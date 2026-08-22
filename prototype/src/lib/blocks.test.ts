import { describe, expect, it } from "vitest";
import { answerViewSchema } from "./blocks";

describe("answerViewSchema", () => {
  it("모델이 상한을 넘겨 쓴 목록을 버리지 않고 잘라 받는다", () => {
    const parsed = answerViewSchema.parse({
      summary: "요약",
      blocks: [
        {
          kind: "bullets",
          title: "해석 시 주의",
          items: Array.from({ length: 12 }, (_, index) => `주의 ${index}`)
        }
      ]
    });

    const block = parsed.blocks[0];
    expect(block?.kind).toBe("bullets");
    if (block?.kind === "bullets") expect(block.items).toHaveLength(8);
  });

  it("긴 문자열은 잘라서 받는다", () => {
    const parsed = answerViewSchema.parse({
      summary: "요약",
      blocks: [{ kind: "metric", label: "가".repeat(300), value: "1" }]
    });

    const block = parsed.blocks[0];
    if (block?.kind !== "metric") throw new Error("metric 블록이어야 한다");
    expect(block.label).toHaveLength(120);
  });

  it("형태가 깨진 블록만 버리고 나머지는 살린다", () => {
    const parsed = answerViewSchema.parse({
      summary: "요약",
      blocks: [
        { kind: "unknown-kind", whatever: true },
        { kind: "series", title: "추이", points: [{ label: "2020", value: 1 }] },
        { kind: "callout", tone: "warn", text: "행이 없습니다" }
      ]
    });

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.kind).toBe("callout");
  });

  it("블록이 하나도 남지 않으면 거절한다", () => {
    const result = answerViewSchema.safeParse({ summary: "요약", blocks: [{ kind: "nope" }] });
    expect(result.success).toBe(false);
  });

  it("점이 하나뿐인 series는 차트로 그리지 않는다", () => {
    const result = answerViewSchema.safeParse({
      summary: "요약",
      blocks: [{ kind: "series", title: "추이", points: [{ label: "2020", value: 1 }] }]
    });
    expect(result.success).toBe(false);
  });
});

describe("scenario / briefing 블록", () => {
  it("전제 칩과 막대가 있는 scenario를 받는다", () => {
    const parsed = answerViewSchema.parse({ summary: "요약", blocks: [
      {
        kind: "scenario",
        title: "세수 영향",
        value: "-8.7억",
        options: [{ label: "낙관적" }, { label: "현상유지", selected: true }],
        bars: [{ ratio: 0.4 }, { ratio: 0.9, highlight: true }]
      }
    ] }).blocks;
    expect(parsed).toHaveLength(1);
  });

  it("비율이 0~1을 벗어난 scenario만 버리고 나머지는 살린다", () => {
    // 그대로 그리면 막대가 카드를 뚫고 나간다. 잘못된 축척은 없느니만 못하다.
    const parsed = answerViewSchema.parse({
      summary: "요약",
      blocks: [
        { kind: "headline", title: "제목" },
        {
          kind: "scenario",
          title: "세수 영향",
          value: "-8.7억",
          options: [{ label: "가" }, { label: "나" }],
          bars: [{ ratio: 0.4 }, { ratio: 1.8 }]
        }
      ]
    }).blocks;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: "headline" });
  });

  it("briefing은 primary만 있어도 통과한다", () => {
    const parsed = answerViewSchema.parse({ summary: "요약", blocks: [
      {
        kind: "briefing",
        title: "34세 · 상주",
        primary: [{ label: "감면 조례", value: "50%" }]
      }
    ] }).blocks;
    expect(parsed).toHaveLength(1);
  });

  it("briefing.primary가 넘치면 앞의 4개만 남긴다", () => {
    const parsed = answerViewSchema.parse({ summary: "요약", blocks: [
      {
        kind: "briefing",
        title: "34세 · 상주",
        primary: Array.from({ length: 7 }, (_, index) => ({
          label: `항목 ${index}`,
          value: `${index}`
        }))
      }
    ] }).blocks;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: "briefing" });
    if (parsed[0]?.kind === "briefing") expect(parsed[0].primary).toHaveLength(4);
  });
});
