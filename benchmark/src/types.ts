/**
 * Shared vocabulary for the vanilla-vs-MCP comparison.
 *
 * The benchmark exists to answer one question: does grounding a model in the
 * Gyeongbuk data layer change what it can truthfully say? Every type here is
 * shaped so that a claim can be traced back to a row in the database, because
 * an evaluation that cannot be audited proves nothing.
 */

/**
 * Why a case is in the suite.
 *
 * The categories are deliberately not all favourable to the MCP arm. A general
 * model genuinely knows that Pohang has roughly half a million residents, and a
 * benchmark that hid such cases would be advocacy rather than measurement.
 */
export type CaseCategory =
  /** A figure a well-read model may plausibly recall. Tests that grounding does not regress. */
  | "common_knowledge"
  /** A figure published after typical training cutoffs. */
  | "recency"
  /** A small jurisdiction or narrow series unlikely to be memorised. */
  | "hyperlocal"
  /** Requires the exact reported figure, not an order of magnitude. */
  | "precision"
  /** The corpus genuinely lacks the answer; the only correct move is to decline. */
  | "abstention"
  /** Scores whether the answer carries provenance that resolves to a real source row. */
  | "provenance";

/** Declarative pointer to the truth, resolved against the database at run time. */
export type GroundTruthSpec =
  | { kind: "population_year"; region: string; year: number }
  | {
      kind: "local_tax_total";
      region: string;
      fiscalYear: number;
      /** Distinguishes collected receipts from reported tax burden; both exist per region. */
      amountSemantics: string;
    }
  | { kind: "council_party_seats"; party: string }
  | { kind: "council_bill_count_year"; year: number }
  | { kind: "press_release_count_year"; year: number }
  | { kind: "policy_program_any" };

/** The truth as the database actually reports it, plus enough context to grade fairly. */
export interface ResolvedGroundTruth {
  /** False when the corpus holds no rows, which makes declining the correct answer. */
  available: boolean;
  /** Representative figure. Null when unavailable. */
  value: number | null;
  /**
   * Spread of the underlying observations.
   *
   * Population is recorded monthly, so "the 2024 population" is a band rather
   * than a point. Grading against the point alone would fail answers that are
   * correct for a different month of the same year.
   */
  range: { min: number; max: number } | null;
  observations: number;
  /** Source ids backing the figure, used to check that cited provenance is real. */
  sourceIds: string[];
  note: string;
}

/** What a correct answer has to do. */
export type Expectation =
  | {
      type: "numeric";
      /** Accepted deviation from the representative value, as a percentage. */
      tolerancePercent: number;
      /** Unit the answer is expected to be expressed in, for the report. */
      unit: string;
    }
  | {
      type: "absent";
    };

export interface BenchmarkCase {
  id: string;
  category: CaseCategory;
  question: string;
  /** Why this case discriminates between the two arms. Printed in the report. */
  rationale: string;
  groundTruth: GroundTruthSpec;
  expect: Expectation;
  /** Whether provenance is scored for this case. */
  requireCitation: boolean;
  /** Analyst minutes to answer by hand, used for the time-saved estimate. */
  manualBaselineMinutes: number;
}

/** Raw output of one arm on one case, before grading. */
export interface ArmResponse {
  arm: "vanilla" | "mcp";
  /**
   * The answer prose, and the only text the grader reads.
   *
   * Kept free of provenance blocks on purpose: source keys are long hex strings
   * and a digit run inside one can coincide with the target figure, which would
   * award credit for an answer that was never given.
   */
  text: string;
  /** Everything the arm produced, including retrieved evidence, for auditing. */
  transcript: string;
  /** Source identifiers the arm put forward, if any. */
  citedSourceIds: string[];
  /** Free-text attributions such as "행정안전부"; counted separately from resolvable ids. */
  citedAttributions: string[];
  /**
   * Whether the arm itself reported that it could not answer.
   *
   * Null when no such signal exists and refusal has to be read from the prose.
   * The grounded arm can say so structurally because it knows its own coverage;
   * that is a capability under test, not a scoring advantage, since declining
   * never earns credit on a case that has an answer.
   */
  declined: boolean | null;
  latencyMs: number;
  /** Populated when the arm failed outright, so failures are not scored as refusals. */
  error: string | null;
}

/** Grading verdict for one arm on one case. */
export interface CaseScore {
  arm: "vanilla" | "mcp";
  caseId: string;
  /** The arm committed to a substantive answer rather than declining. */
  committed: boolean;
  /** The arm satisfied the expectation. */
  correct: boolean;
  /**
   * The arm asserted something the data contradicts.
   *
   * Distinct from `!correct`: declining to answer is incorrect on a numeric
   * case but is not a hallucination, and the difference is the whole point.
   */
  hallucinated: boolean;
  /** Numbers recovered from the answer, after discarding years and percentages. */
  extractedValues: number[];
  /** The value that matched, when one did. */
  matchedValue: number | null;
  citationsClaimed: number;
  /** Citations that resolve to a real row in `data_source`. */
  citationsVerifiable: number;
  latencyMs: number;
  notes: string[];
}

export interface ArmSummary {
  arm: "vanilla" | "mcp";
  cases: number;
  correct: number;
  accuracy: number;
  /**
   * Share of cases the arm answered instead of declining.
   *
   * Published beside the hallucination rate because the two are only
   * interpretable together: an arm that declines everything scores a perfect
   * hallucination rate while being useless.
   */
  commitmentRate: number;
  /** Share of cases where the arm asserted something false. */
  hallucinationRate: number;
  /** Share of the arm's *asserted* answers that were false. */
  hallucinationPerCommitted: number;
  /** Of the abstention cases, the share correctly declined. */
  abstentionAccuracy: number;
  /** Of all citations offered, the share that resolve to a real source row. */
  citationVerifiability: number;
  medianLatencyMs: number;
  errors: number;
}

export interface BenchmarkReport {
  generatedAt: string;
  model: string;
  mode: "live" | "offline";
  cases: number;
  arms: ArmSummary[];
  byCategory: Array<{
    category: CaseCategory;
    cases: number;
    vanillaAccuracy: number;
    mcpAccuracy: number;
  }>;
  scores: CaseScore[];
  groundTruth: Array<{ caseId: string; resolved: ResolvedGroundTruth }>;
  responses: ArmResponse[];
  /** Analyst hours the MCP arm's correct answers stand in for. */
  minutesSavedOnCorrect: number;
}
