import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import {
  parsePopulationWorkbook,
  populationWorkbookReferenceDate
} from "./xlsx.js";

function workbookBuffer(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [],
    ["1-3. 읍면동별 인구 및 세대현황(2026년 7월)"],
    [],
    ["구분", "세대", "내국인"],
    ["경상북도", 1303639, 2494470, 1263571, 1230899],
    ["포항시", 240438, 487018, 246696, 240322],
    ["남구", 108236, 211509, 109677, 101832],
    ["군위군", 12000, 22000, 11000, 11000]
  ]);
  XLSX.utils.book_append_sheet(
    workbook,
    sheet,
    "1-3. 읍면동별 인구 및 세대현황"
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("population workbook adapter", () => {
  it("derives the month-end reference date from the workbook title", () => {
    expect(populationWorkbookReferenceDate(workbookBuffer())).toBe("2026-07-31");
  });

  it("keeps only canonical Gyeongbuk aggregate rows and correct totals", () => {
    expect(parsePopulationWorkbook(workbookBuffer())).toEqual([
      {
        sheet: "1-3. 읍면동별 인구 및 세대현황",
        regionName: "경상북도",
        referenceDate: "2026-07-31",
        populationTotal: 2494470,
        populationMale: 1263571,
        populationFemale: 1230899,
        householdCount: 1303639,
        foreignPopulation: null,
        sourceRow: 5
      },
      {
        sheet: "1-3. 읍면동별 인구 및 세대현황",
        regionName: "포항시",
        referenceDate: "2026-07-31",
        populationTotal: 487018,
        populationMale: 246696,
        populationFemale: 240322,
        householdCount: 240438,
        foreignPopulation: null,
        sourceRow: 6
      }
    ]);
  });
});
