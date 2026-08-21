import * as XLSX from "xlsx";

export interface WorkbookPopulationRow {
  sheet: string;
  regionName: string;
  year: number;
  populationTotal: number;
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

export function parsePopulationWorkbook(buffer: Buffer): WorkbookPopulationRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const results: WorkbookPopulationRow[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheetName.normalize("NFC").includes("인구")) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: true
    });
    const yearCell = rows
      .flat()
      .map(text)
      .find((value) => /20\d{2}년/.test(value));
    const year = Number(yearCell?.match(/20\d{2}/)?.[0] ?? 0);
    if (!year) continue;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] ?? [];
      const regionCell = row.map(text).find((value) => /^[가-힣]+[시군]$/.test(value));
      if (!regionCell || regionCell.endsWith("남구") || regionCell.endsWith("북구")) continue;
      const numbers = row.map(numeric).filter((value): value is number => value !== null);
      const plausiblePopulation = numbers.find(
        (value) => value >= 10_000 && value <= 10_000_000
      );
      if (plausiblePopulation) {
        results.push({
          sheet: sheetName.normalize("NFC"),
          regionName: regionCell,
          year,
          populationTotal: Math.trunc(plausiblePopulation),
          sourceRow: index + 1
        });
      }
    }
  }
  return results.filter(
    (row, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.sheet === row.sheet &&
          candidate.regionName === row.regionName &&
          candidate.year === row.year
      ) === index
  );
}

