import { describe, expect, it } from "vitest";
import { extractKoreanNumbers, findMatch } from "./korean-number.js";

describe("extractKoreanNumbers", () => {
  it("reads comma-grouped digits", () => {
    expect(extractKoreanNumbers("포항시 인구는 499,839명입니다.")).toContain(499_839);
  });

  it("reads a rounded myriad expression", () => {
    expect(extractKoreanNumbers("약 50만 명 수준입니다.")).toContain(500_000);
  });

  it("folds a descending myriad chain into one figure", () => {
    // "49만 9839명" is a single number written the way Korean writes it, and
    // reading it as 490,000 plus a stray 9,839 would score a correct answer wrong.
    expect(extractKoreanNumbers("49만 9839명")).toEqual([499_839]);
  });

  it("folds three descending groups", () => {
    expect(extractKoreanNumbers("13만 2천 명")).toEqual([132_000]);
  });

  it("reads mixed 억/만 currency", () => {
    expect(extractKoreanNumbers("1,077억 2,031만원")).toEqual([107_720_310_000]);
  });

  it("reads a full won amount", () => {
    expect(extractKoreanNumbers("107,720,311,000원")).toEqual([107_720_311_000]);
  });

  it("discards calendar years", () => {
    // Without this the year in the question would match almost any target.
    expect(extractKoreanNumbers("2024년 기준 자료입니다.")).toEqual([]);
  });

  it("keeps a grouped figure that happens to sit in the year range", () => {
    expect(extractKoreanNumbers("총 2,024건이 접수되었습니다.")).toEqual([2_024]);
  });

  it("discards percentages and ranks", () => {
    expect(extractKoreanNumbers("전년 대비 3.2% 감소하여 전국 5위입니다.")).toEqual([]);
  });

  it("does not merge two independent figures of the same magnitude", () => {
    expect(extractKoreanNumbers("남 10만 여 20만")).toEqual([100_000, 200_000]);
  });

  it("returns nothing for prose without figures", () => {
    expect(extractKoreanNumbers("확인할 수 없습니다.")).toEqual([]);
  });
});

describe("findMatch", () => {
  it("accepts a value inside the tolerance band", () => {
    expect(findMatch([500_000], 499_839, 5)).toBe(500_000);
  });

  it("rejects a value outside the tolerance band", () => {
    expect(findMatch([450_000], 499_839, 1)).toBeNull();
  });

  it("accepts any month of a monthly series via the observation band", () => {
    // The headline figure is December's, but a source quoting March is not wrong.
    expect(
      findMatch([499_352], 499_839, 0.01, { min: 499_352, max: 500_002 })
    ).toBe(499_352);
  });

  it("prefers the closest candidate when several match", () => {
    expect(findMatch([490_000, 499_800], 499_839, 5)).toBe(499_800);
  });
});
