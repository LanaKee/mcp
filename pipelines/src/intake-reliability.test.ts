import { describe, expect, it } from "vitest";
import { evaluateStressDecisions } from "./intake-reliability.js";
import type { IntakeDecision } from "./intake.js";

function decision(
  fileName: string,
  action: IntakeDecision["action"],
  rejectionCode: IntakeDecision["rejectionCode"] = null
): IntakeDecision {
  return {
    fileName,
    inboxPath: fileName,
    sha256: "a".repeat(64),
    byteSize: 1,
    mediaType: "text/csv",
    contentKind: action === "quarantined" ? "unknown" : "population_annual",
    encoding: "utf8",
    referenceDate: "2024-12-31",
    action,
    storedPath: action === "accepted" || action === "revision" ? fileName : null,
    duplicateOfPath: action === "duplicate" ? "original.csv" : null,
    rejectionCode,
    rejectionMessage: rejectionCode,
  };
}

describe("ingestion reliability verdict", () => {
  it("counts all ten scenarios only when every safety property holds", () => {
    const verdict = evaluateStressDecisions({
      first: [
        decision("01-경상북도_포항시_연도별인구_20241231.csv", "accepted"),
        decision("02-동일내용_다른이름.csv", "duplicate"),
        decision("03-fake-html.csv", "quarantined", "html_error_page"),
        decision("04-empty.csv", "quarantined", "empty_file"),
        decision("05-경상북도_김천시_연도별인구_20241231.csv", "accepted"),
        decision("06-경상북도_없는시_연도별인구_20241231.csv", "accepted"),
        decision("07-header-only.csv", "quarantined", "no_data_rows"),
        decision("08-malformed.json", "quarantined", "unparsable_content")
      ],
      revision: [
        decision("01-경상북도_포항시_연도별인구_20241231.csv", "revision")
      ],
      reprocess: [
        decision("01-경상북도_포항시_연도별인구_20241231.csv", "duplicate")
      ],
      unknownRegionFactRows: 0,
      factCountBeforeReprocess: 3,
      factCountAfterReprocess: 3,
      originalStillExists: true,
      revisionExists: true,
      expectedArtifacts: 10,
      observedArtifacts: 10,
      pipelineFailed: false
    });

    expect(verdict).toMatchObject({
      scenarios: 10,
      handledCorrectly: 10,
      duplicateFactsAfterReprocess: 0,
      silentOverwrites: 0,
      dataLoss: 0,
      wholePipelineFailure: false
    });
  });
});
