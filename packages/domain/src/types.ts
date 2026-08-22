import type { DataStatus, SourceRef } from "./schemas.js";

export interface PopulationRecord {
  regionId: string;
  regionName: string;
  year: number;
  populationTotal: number;
  measurementBasis:
    | "resident_registration_snapshot"
    | "tax_year_reported_population"
    | "annual_statistical_population"
    | "demo_annual_population";
  referenceDatePrecision: "day" | "month" | "year";
  sourceId: string;
  dataStatus: DataStatus;
}

export interface LocalTaxRecord {
  regionId: string;
  regionName: string;
  fiscalYear: number;
  taxCategory: string;
  revenueAmountWon: number;
  accountingBasis: "settlement" | "budget" | "reported";
  amountSemantics?:
    | "collected_amount"
    | "payment_amount"
    | "reported_total_tax_burden"
    | "demo_settlement";
  sourceGrain?:
    | "collection_status"
    | "statistical_yearbook_local_collection"
    | "payment_media"
    | "per_capita_burden"
    | "demo_sample";
  unitOriginal?: "KRW" | "thousand_KRW";
  unitMultiplier?: 1 | 1000;
  sourceId: string;
  dataStatus: DataStatus;
}

export interface PolicyRecord {
  policyId: string;
  title: string;
  regionId: string;
  regionName: string;
  ageMin: number | null;
  ageMax: number | null;
  industries: string[];
  stages: string[];
  eligibilityText: string;
  support: string;
  applicationPeriod: string;
  sourceId: string;
  dataStatus: DataStatus;
}

export interface CouncilRecord {
  recordId: string;
  regionId: string;
  regionName: string;
  council: string;
  meetingDate: string;
  session: string;
  title: string;
  content: string;
  sourceId: string;
  locator: string;
  dataStatus: DataStatus;
}

export interface TrendPoint {
  year: number;
  value: number;
  sourceId: string;
}

export interface TrendSummary {
  startValue: number;
  endValue: number;
  absoluteChange: number;
  changePercent: number | null;
  changePercentUnavailableReason: "zero_baseline" | null;
  direction: "increase" | "decrease" | "flat";
}

export type TrendSummaryUnavailableReason =
  | "insufficient_points"
  | "incomparable_sources";

export interface TrendCompatibility {
  dataStatus: DataStatus;
  populationMeasurementBasis: PopulationRecord["measurementBasis"] | null;
  referenceDatePrecision: PopulationRecord["referenceDatePrecision"] | null;
  accountingBasis: LocalTaxRecord["accountingBasis"] | null;
  amountSemantics: LocalTaxRecord["amountSemantics"] | null;
  sourceGrain: LocalTaxRecord["sourceGrain"] | null;
  unitOriginal: LocalTaxRecord["unitOriginal"] | null;
  unitMultiplier: LocalTaxRecord["unitMultiplier"] | null;
}

export interface ComparableTrendPoint extends TrendPoint {
  compatibility: TrendCompatibility;
}

export interface TrendSeriesSegment {
  compatibility: TrendCompatibility;
  points: TrendPoint[];
  summary: TrendSummary | null;
  summaryUnavailableReason: "insufficient_points" | null;
}

export interface ComparableTrendAnalysis {
  summary: TrendSummary | null;
  summaryUnavailableReason: TrendSummaryUnavailableReason | null;
  segments: TrendSeriesSegment[];
}

/**
 * One region's contribution to a peer comparison, or the reason it was left out.
 *
 * An excluded region is reported rather than dropped. A comparison that quietly
 * omits the region a reader asked about invites them to conclude the region is
 * average, which is the opposite of what the data supports.
 */
export interface PeerRegionSeries {
  region: string;
  years: number[];
  values: number[];
  summary: TrendSummary | null;
  summaryUnavailableReason: TrendSummaryUnavailableReason | null;
  sourceIds: string[];
}

export interface PeerRegionExclusion {
  region: string;
  reason:
    | "no_observations"
    | "incompatible_with_peers";
  detail: string;
}

export interface PeerComparison {
  metric: string;
  unit: string;
  /** The years every included region observed. Comparisons use only these. */
  commonYears: number[];
  included: PeerRegionSeries[];
  excluded: PeerRegionExclusion[];
  /** Ranking by the latest common year's level, highest first. */
  levelRanking: Array<{ region: string; year: number; value: number }>;
  /**
   * Ranking by change across the common window, most negative first. Null when
   * fewer than two common years exist, because a single point has no change.
   */
  changeRanking:
    | Array<{ region: string; changePercent: number | null; absoluteChange: number }>
    | null;
  changeRankingUnavailableReason: "insufficient_common_years" | null;
  comparabilityBasis: TrendCompatibility | null;
  comparabilityRefusalReason: string | null;
}

export interface ToolEnvelope<T> {
  dataStatus: DataStatus;
  result: T;
  sources: SourceRef[];
  limitations: string[];
}

export interface PolicyMatch {
  policy: PolicyRecord;
  eligible: boolean;
  reasons: string[];
  unmetConditions: string[];
  score: number;
}
