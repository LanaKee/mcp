import type { DataStatus, SourceRef } from "./schemas.js";

export interface PopulationRecord {
  regionId: string;
  regionName: string;
  year: number;
  populationTotal: number;
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
  changePercent: number;
  direction: "increase" | "decrease" | "flat";
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
