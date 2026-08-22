import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectEtlData, repositoryRoot } from "./etl.js";
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
      const { catalog } = await collectEtlData();
      const paths = new Set(fixtures.map((fixture) => fixture.sourcePath));
      const plan = await normalizePdfCatalog(
        catalog.filter((entry) => paths.has(entry.path))
      );
      const results = evaluateGoldenFixtures(plan, catalog, fixtures);
      expect(results).toHaveLength(fixtures.length);
      expect(results.every((result) => result.passed)).toBe(true);
    },
    120_000
  );
});
