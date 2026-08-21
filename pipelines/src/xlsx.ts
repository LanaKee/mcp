import * as XLSX from "xlsx";
import { parseReferenceDate } from "./dates.js";
import { resolveGyeongbukRegion } from "./regions.js";

export interface WorkbookPopulationRow {
  sheet: string;
  regionName: string;
  referenceDate: string;
  populationTotal: number;
  populationMale: number | null;
  populationFemale: number | null;
  householdCount: number | null;
  foreignPopulation: null;
  sourceRow: number;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return value === null || value === undefined
    ? ""
    : String(value).normalize("NFC").trim();
}

function referenceDateFromWorkbook(workbook: XLSX.WorkBook): string | null {
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: true
    });
    for (const value of rows.slice(0, 5).flat().map(text)) {
      const parsed = parseReferenceDate(value, { monthEndWhenDayMissing: true });
      if (parsed) return parsed;
    }
  }
  return null;
}

export function populationWorkbookReferenceDate(buffer: Buffer): string | null {
  return referenceDateFromWorkbook(XLSX.read(buffer, { type: "buffer", cellDates: false }));
}

export function parsePopulationWorkbook(buffer: Buffer): WorkbookPopulationRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const referenceDate = referenceDateFromWorkbook(workbook);
  if (!referenceDate) return [];
  const results: WorkbookPopulationRow[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (
      !sheet ||
      !sheetName.normalize("NFC").includes("읍면동별 인구 및 세대현황")
    ) {
      continue;
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: true
    });
    const firstSheetRow = sheet["!ref"]
      ? XLSX.utils.decode_range(sheet["!ref"]).s.r + 1
      : 1;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] ?? [];
      const region = resolveGyeongbukRegion(text(row[0]));
      const populationTotal = numeric(row[2]);
      if (!region || populationTotal === null || populationTotal <= 0) continue;
      results.push({
        sheet: sheetName.normalize("NFC"),
        regionName: region.regionName,
        referenceDate,
        populationTotal: Math.trunc(populationTotal),
        populationMale:
          numeric(row[3]) === null ? null : Math.trunc(numeric(row[3])!),
        populationFemale:
          numeric(row[4]) === null ? null : Math.trunc(numeric(row[4])!),
        householdCount:
          numeric(row[1]) === null ? null : Math.trunc(numeric(row[1])!),
        foreignPopulation: null,
        sourceRow: firstSheetRow + index
      });
    }
  }
  return results.filter(
    (row, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.regionName === row.regionName &&
          candidate.referenceDate === row.referenceDate
      ) === index
  );
}
