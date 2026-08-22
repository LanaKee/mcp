import { describe, expect, it } from "vitest";
import {
  DATASET_CATALOG,
  DATASET_RELATIONSHIPS,
  datasetSearchText,
  getDatasetDefinition,
  isDatasetRelevant,
  joinability,
  listDatasetIds,
  relationshipsFor
} from "./catalog.js";

describe("dataset catalog", () => {
  it("gives every dataset a unique id, tool binding and usage rule", () => {
    const ids = listDatasetIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const dataset of DATASET_CATALOG) {
      expect(dataset.tools.length).toBeGreaterThan(0);
      expect(dataset.usageRules.length).toBeGreaterThan(0);
      expect(dataset.keywords.length).toBeGreaterThan(0);
    }
  });

  it("marks narrative datasets so they cannot be mistaken for observations", () => {
    // The trust model depends on this split: press releases and council
    // transcripts describe what officials said, not what was measured.
    expect(getDatasetDefinition("press_release")?.evidenceRole).toBe(
      "narrative_context_only"
    );
    expect(getDatasetDefinition("council_record")?.evidenceRole).toBe(
      "narrative_context_only"
    );
    expect(getDatasetDefinition("population_observation")?.evidenceRole).toBe(
      "observed_fact"
    );
    expect(getDatasetDefinition("local_tax_revenue")?.evidenceRole).toBe(
      "observed_fact"
    );
  });

  it("attaches a comparability caveat to every numeric measure", () => {
    // A unit alone is not enough to make two numbers comparable; the catalog
    // must say what would make a comparison invalid.
    for (const dataset of DATASET_CATALOG) {
      for (const measure of dataset.measures) {
        expect(measure.unit).not.toBeNull();
        expect(measure.semantics.length).toBeGreaterThan(0);
        expect(measure.comparabilityCaveat).toBeTruthy();
      }
    }
  });

  it("only declares relationships between datasets that exist", () => {
    const ids = new Set(listDatasetIds());
    for (const relationship of DATASET_RELATIONSHIPS) {
      expect(ids.has(relationship.from)).toBe(true);
      expect(ids.has(relationship.to)).toBe(true);
      expect(relationship.caveats.length).toBeGreaterThan(0);
    }
  });

  it("only claims join keys that both sides actually expose", () => {
    for (const relationship of DATASET_RELATIONSHIPS) {
      const from = getDatasetDefinition(relationship.from)!;
      const to = getDatasetDefinition(relationship.to)!;
      for (const key of relationship.joinKeys) {
        const onFrom = from.dimensions.find(
          (dimension) => dimension.name === key && dimension.joinKey
        );
        const onTo = to.dimensions.find(
          (dimension) => dimension.name === key && dimension.joinKey
        );
        expect(onFrom, `${relationship.from} lacks join key ${key}`).toBeTruthy();
        expect(onTo, `${relationship.to} lacks join key ${key}`).toBeTruthy();
      }
    }
  });

  it("reports relationships from both directions with the query dataset first", () => {
    const forward = relationshipsFor("population_observation").find(
      (relationship) => relationship.to === "local_tax_revenue"
    );
    const reverse = relationshipsFor("local_tax_revenue").find(
      (relationship) => relationship.to === "population_observation"
    );
    expect(forward).toBeTruthy();
    expect(reverse).toBeTruthy();
    expect(reverse!.from).toBe("local_tax_revenue");
    expect(reverse!.joinKeys).toEqual(forward!.joinKeys);
  });

  it("treats an undeclared pair as not joinable", () => {
    expect(joinability("population_observation", "local_tax_revenue")).toBeTruthy();
    expect(joinability("press_release", "council_bill")).toBeNull();
  });

  it("matches Korean query words that carry particles", () => {
    // "인구는" will never equal the vocabulary term "인구"; agglutinative
    // suffixes must not break dataset discovery.
    const population = getDatasetDefinition("population_observation")!;
    expect(isDatasetRelevant(population, "인구는 줄었나")).toBe(true);
    expect(isDatasetRelevant(population, "인구 감소 추이")).toBe(true);
  });

  it("rejects queries that share no curated vocabulary", () => {
    // Character-bigram scoring alone would match almost anything, so relevance
    // is gated on curated terms rather than on a nonzero score.
    for (const dataset of DATASET_CATALOG) {
      expect(isDatasetRelevant(dataset, "zzzz 존재하지않는주제 qqqq")).toBe(false);
      expect(isDatasetRelevant(dataset, "")).toBe(false);
    }
  });

  it("does not let a dataset be selected by common description words alone", () => {
    // "주제" appears in a description but is not curated vocabulary.
    const council = getDatasetDefinition("council_record")!;
    expect(datasetSearchText(council)).toContain("주제");
    expect(isDatasetRelevant(council, "주제")).toBe(false);
    expect(isDatasetRelevant(council, "회의록")).toBe(true);
  });

  it("includes keywords and measure semantics in the searchable text", () => {
    const text = datasetSearchText(getDatasetDefinition("local_tax_revenue")!);
    expect(text).toContain("지방세");
    expect(text).toContain("세수");
    expect(text).toContain("회계연도");
  });
});

describe("place names are not topics", () => {
  it("does not make any dataset relevant from a region name alone", () => {
    for (const query of ["경상북도", "포항시", "울진군", "경북 시군"]) {
      const matched = DATASET_CATALOG.filter((dataset) =>
        isDatasetRelevant(dataset, query)
      );
      expect(matched, `"${query}"`).toHaveLength(0);
    }
  });

  it("refuses an out-of-scope topic that merely mentions the province", () => {
    // 국세 is national-tax, outside this project's scope. Before geographic
    // terms were removed from the gate this matched the press-release dataset
    // on "경상북도" and produced a sourced-looking answer to a question the
    // system has no data for.
    const matched = DATASET_CATALOG.filter((dataset) =>
      isDatasetRelevant(dataset, "경상북도의 국세 납부 실적을 알려줘")
    );
    expect(matched).toHaveLength(0);
  });

  it("still matches when a real topic accompanies the region name", () => {
    const matched = DATASET_CATALOG.filter((dataset) =>
      isDatasetRelevant(dataset, "포항시 인구 추이")
    ).map((dataset) => dataset.datasetId);
    expect(matched).toContain("population_observation");
  });
});

describe("evidence contracts", () => {
  it("gives every dataset a contract that states both sides", () => {
    // A contract with an empty `cannotClaim` is the dangerous case: it reads as
    // "this dataset can support anything", which is never true here.
    for (const dataset of DATASET_CATALOG) {
      expect(dataset.evidenceContract.canClaim.length).toBeGreaterThan(0);
      expect(dataset.evidenceContract.cannotClaim.length).toBeGreaterThan(0);
    }
  });

  it("keeps the contract role consistent with the dataset's evidence role", () => {
    for (const dataset of DATASET_CATALOG) {
      expect(dataset.evidenceContract.role).toBe(dataset.evidenceRole);
    }
  });

  it("tells the reader where a forbidden claim must come from instead", () => {
    // A contract that only says "you may not conclude this" leaves the user
    // stuck; the point is to redirect them to the source that can answer it.
    for (const dataset of DATASET_CATALOG) {
      expect(dataset.evidenceContract.insteadUse).toBeTruthy();
    }
  });

  it("forbids narrative datasets from supporting their own numbers", () => {
    // This is the single most important line in the whole catalog: a press
    // release quoting a target figure is the most likely thing to be mistaken
    // for an observed statistic.
    const narrative = DATASET_CATALOG.filter(
      (dataset) => dataset.evidenceRole === "narrative_context_only"
    );
    expect(narrative.length).toBeGreaterThan(0);
    for (const dataset of narrative) {
      const forbidden = dataset.evidenceContract.cannotClaim.join(" ");
      expect(forbidden).toMatch(/수치|공약|집행|성과/);
    }
  });
});
