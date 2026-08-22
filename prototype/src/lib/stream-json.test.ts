import { describe, expect, it } from "vitest";
import { completedBlocks, completedSummary } from "./stream-json";

describe("completedSummary", () => {
  it("문자열이 닫히기 전에는 아무것도 주지 않는다", () => {
    expect(completedSummary('{"summary": "상주시 인구는')).toBeNull();
  });

  it("닫힌 요약을 이스케이프까지 풀어 돌려준다", () => {
    expect(completedSummary('{"summary": "\\"상주\\" 기준", "blocks": [')).toBe('"상주" 기준');
  });
});

describe("completedBlocks", () => {
  it("blocks 배열이 시작되기 전에는 비어 있다", () => {
    expect(completedBlocks('{"summary": "요약"')).toEqual([]);
  });

  it("닫힌 객체만 순서대로 돌려준다", () => {
    const text = '{"summary":"s","blocks":[{"kind":"headline","title":"가"},{"kind":"metric"';
    expect(completedBlocks(text)).toEqual(['{"kind":"headline","title":"가"}']);
  });

  it("문자열 안의 중괄호에 어긋나지 않는다", () => {
    // 이 케이스를 세지 않으면 스캐너가 한 칸씩 밀려 남은 블록을 통째로 잃는다.
    const text = '{"blocks":[{"kind":"headline","title":"{ 중괄호 } 포함"},{"kind":"x"';
    expect(completedBlocks(text)).toEqual(['{"kind":"headline","title":"{ 중괄호 } 포함"}']);
  });

  it("중첩 객체를 하나의 블록으로 센다", () => {
    const text =
      '{"blocks":[{"kind":"series","points":[{"label":"2020","value":1}],"title":"가"}]}';
    expect(completedBlocks(text)).toHaveLength(1);
    expect(JSON.parse(completedBlocks(text)[0]!)).toMatchObject({ kind: "series" });
  });

  it("이스케이프된 따옴표를 문자열의 끝으로 착각하지 않는다", () => {
    const text = '{"blocks":[{"kind":"headline","title":"\\"가\\""},{"kind":"y"';
    expect(completedBlocks(text)).toEqual(['{"kind":"headline","title":"\\"가\\""}']);
  });
});
