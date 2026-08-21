import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog } from "./catalog.js";
import {
  normalizeAnnualPopulation,
  normalizeCouncilRows,
  parseKoreanCsv
} from "./csv.js";
import { parsePopulationWorkbook } from "./xlsx.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const datasetDirectory = resolve(root, "datasets");
const generatedDirectory = resolve(root, "data/generated");
const writeMode = process.argv.includes("--write");

async function writeIfChanged(path: string, value: unknown): Promise<"updated" | "unchanged"> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if ((await readFile(path, "utf8")) === content) return "unchanged";
  } catch {
    // The first run has no previous generated file.
  }
  await mkdir(dirname(path), { recursive: true });
  const nextPath = `${path}.next`;
  await writeFile(nextPath, content, "utf8");
  await rename(nextPath, path);
  return "updated";
}

async function run() {
  const catalog = await buildCatalog(datasetDirectory, root);
  const population: unknown[] = [];
  const council: unknown[] = [];
  const errors: Array<{ path: string; error: string }> = catalog
    .filter((entry) => entry.error)
    .map((entry) => ({ path: entry.path, error: entry.error! }));

  for (const entry of catalog) {
    try {
      const absolute = resolve(root, entry.path);
      if (entry.extension === ".csv" && entry.parseStatus === "parsed") {
        const parsed = parseKoreanCsv(await readFile(absolute));
        population.push(
          ...normalizeAnnualPopulation(parsed, entry.fileNameNfc).map((row) => ({
            ...row,
            sourcePath: entry.path,
            sourceSha256: entry.sha256,
            dataStatus: "official_observed"
          }))
        );
        council.push(
          ...normalizeCouncilRows(parsed, entry.fileNameNfc).map((row) => ({
            ...row,
            sourcePath: entry.path,
            sourceSha256: entry.sha256,
            dataStatus: "official_observed"
          }))
        );
      } else if (entry.extension === ".xlsx") {
        population.push(
          ...parsePopulationWorkbook(await readFile(absolute)).map((row) => ({
            ...row,
            sourcePath: entry.path,
            sourceSha256: entry.sha256,
            dataStatus: "official_observed"
          }))
        );
      }
    } catch (caught) {
      errors.push({
        path: entry.path,
        error: caught instanceof Error ? caught.message : String(caught)
      });
    }
  }

  const summary = {
    mode: writeMode ? "write" : "dry-run",
    files: catalog.length,
    byExtension: Object.fromEntries(
      [...new Set(catalog.map((entry) => entry.extension))].map((extension) => [
        extension,
        catalog.filter((entry) => entry.extension === extension).length
      ])
    ),
    byContentKind: Object.fromEntries(
      [...new Set(catalog.map((entry) => entry.contentKind))].map((kind) => [
        kind,
        catalog.filter((entry) => entry.contentKind === kind).length
      ])
    ),
    normalizedPopulationRows: population.length,
    normalizedCouncilRows: council.length,
    errors
  };

  if (writeMode) {
    const writes = {
      catalog: await writeIfChanged(resolve(generatedDirectory, "catalog.json"), catalog),
      population: await writeIfChanged(
        resolve(generatedDirectory, "population.normalized.json"),
        population
      ),
      council: await writeIfChanged(
        resolve(generatedDirectory, "council.normalized.json"),
        council
      ),
      errors: await writeIfChanged(resolve(generatedDirectory, "errors.json"), errors)
    };
    console.log(JSON.stringify({ ...summary, writes }, null, 2));
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
  if (errors.length > 0) process.exitCode = 2;
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

