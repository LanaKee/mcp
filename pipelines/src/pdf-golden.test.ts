import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.js";
import { datasetDirectory, repositoryRoot } from "./etl.js";
import { normalizePdfCatalog } from "./pdf.js";
import {
  evaluateGoldenFixtures,
  loadPdfGoldenFixtures
} from "./pdf-quality.js";

const fixturePath =
  "datasets/경상북도 김천시_의회 회의록_20231226/211회/제211회 김천시의회 본회의 1차(20200420).pdf";
const localCorpusAvailable = existsSync(`${repositoryRoot}/${fixturePath}`);

describe.skipIf(!localCorpusAvailable)("local PDF golden pages", () => {
  it(
    "matches source hashes, page hashes, structural markers, and cleaned margins",
    async () => {
      const fixtures = await loadPdfGoldenFixtures();
      const paths = new Set(fixtures.map((fixture) => fixture.sourcePath));
      // Cataloguing the whole datasets/ tree reads and hashes every file, which
      // grows with each new dataset and has nothing to do with PDF golden
      // pages. Only the six fixture PDFs are described here.
      const catalog = await buildCatalog(datasetDirectory, repositoryRoot, (path) =>
        paths.has(path)
      );
      const plan = await normalizePdfCatalog(catalog);
      const results = evaluateGoldenFixtures(plan, catalog, fixtures);
      expect(results).toHaveLength(fixtures.length);
      expect(results.every((result) => result.passed)).toBe(true);
    },
    120_000
  );
});
