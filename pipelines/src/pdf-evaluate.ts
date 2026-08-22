import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectEtlData, generatedDirectory } from "./etl.js";
import { normalizePdfCatalog } from "./pdf.js";
import {
  buildPdfQualityReport,
  loadPdfGoldenFixtures
} from "./pdf-quality.js";

function parseLimit(arguments_: string[]): number | undefined {
  const index = arguments_.indexOf("--limit");
  if (index === -1) return undefined;
  const value = Number(arguments_[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return value;
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  const { catalog } = await collectEtlData();
  const fixtures = await loadPdfGoldenFixtures();
  const pdfEntries = catalog
    .filter((entry) => entry.extension === ".pdf")
    .sort((left, right) => left.path.localeCompare(right.path));
  const selected = limit === undefined ? pdfEntries : pdfEntries.slice(0, limit);
  const selectedPaths = new Set(selected.map((entry) => entry.path));
  for (const fixture of fixtures) {
    const entry = pdfEntries.find((candidate) => candidate.path === fixture.sourcePath);
    if (entry && !selectedPaths.has(entry.path)) {
      selected.push(entry);
      selectedPaths.add(entry.path);
    }
  }
  const plan = await normalizePdfCatalog(selected, {
    onProgress: ({ current, total, path, status, pages, chunks }) => {
      process.stderr.write(
        `${JSON.stringify({ current, total, path, status, pages, chunks })}\n`
      );
    }
  });
  const report = buildPdfQualityReport(plan, catalog, fixtures);
  const reportPath = resolve(generatedDirectory, "pdf.quality.report.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      reportPath,
      files: report.summary.files,
      pages: report.summary.pages,
      chunks: report.summary.chunks,
      golden: report.golden,
      severeRegressions: report.severeRegressions,
      distribution: report.distribution
    })}\n`
  );
  if (report.severeRegressions.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
