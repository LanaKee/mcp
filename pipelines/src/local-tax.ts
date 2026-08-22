import { createHash } from "node:crypto";
import {
  GYEONGBUK_REGIONS,
  inferGyeongbukRegion,
  resolveGyeongbukRegion,
  type GyeongbukRegion
} from "./regions.js";

export type LocalTaxCsvKind =
  | "local_tax_collection"
  | "local_tax_payment_media"
  | "local_tax_assessment"
  | "local_tax_per_capita"
  | "local_tax_taxpayer"
  | "local_tax_exemption"
  | "local_tax_exemption_unverified"
  | "local_tax_unrefunded"
  | "local_tax_enforcement"
  | "property_valuation_microdata";

export type TaxQualitySeverity = "info" | "warning" | "error";
export type TaxUnitOriginal = "KRW" | "thousand_KRW";
export type TaxUnitProvenance =
  | "explicit_header_krw"
  | "explicit_header_thousand_krw"
  | "unmarked_header_default_krw"
  | "cross_source_reconciliation_thousand_krw";

export interface LocalTaxSourceInput {
  path: string;
  sha256: string;
  headers: string[];
  rows: Record<string, string>[];
  kind: LocalTaxCsvKind;
}

export interface TaxQualityIssue {
  severity: TaxQualitySeverity;
  issueCode: string;
  entityType: string;
  sourcePath: string;
  sourceSha256: string;
  sourceRow: number | null;
  fieldName: string | null;
  message: string;
  observed: unknown;
  expected: unknown;
  quarantined: boolean;
}

export interface TaxReconciliation {
  reconciliationCode: string;
  sourcePath: string;
  regionId: string;
  fiscalYear: number;
  status: "passed" | "warning";
  details: Record<string, unknown>;
}

interface TaxSourceRow {
  regionId: string;
  regionName: string;
  fiscalYear: number;
  sourcePath: string;
  sourceSha256: string;
  sourceRow: number;
  unitOriginal: TaxUnitOriginal;
  unitMultiplier: 1 | 1000;
  unitProvenance: TaxUnitProvenance;
}

export interface NormalizedTaxCollection extends TaxSourceRow {
  taxCategory: string;
  assessedAmountWon: number;
  collectedAmountWon: number;
  refundedAmountWon: number | null;
  writtenOffAmountWon: number | null;
  uncollectedAmountWon: number | null;
  reportedCollectionRate: number | null;
  computedCollectionRate: number | null;
  isAggregate: boolean;
}

export interface NormalizedTaxPaymentMedia extends TaxSourceRow {
  taxCategory: string;
  paymentMethod: string | null;
  electronicNotice: boolean | null;
  paymentCount: number;
  paymentAmountWon: number;
  reportedMediaShare: number | null;
  isAggregate: boolean;
}

export interface NormalizedTaxAssessment extends TaxSourceRow {
  taxCategory: string;
  assessedCount: number | null;
  assessedAmountWon: number | null;
  nonTaxableCount: number | null;
  nonTaxableAmountWon: number | null;
  isAggregate: boolean;
}

export interface NormalizedTaxPerCapita extends TaxSourceRow {
  perResidentAmountWon: number;
  perHouseholdAmountWon: number;
  totalLocalTaxAmountWon: number;
  populationCount: number | null;
  householdCount: number | null;
}

export interface NormalizedTaxpayerStatus extends TaxSourceRow {
  taxCategory: string;
  taxpayerType: string;
  jurisdictionScope: string;
  taxpayerCount: number;
  isAggregate: boolean;
}

export interface NormalizedTaxExemption extends TaxSourceRow {
  taxCategory: string;
  nonTaxableAmountWon: number;
  reductionAmountWon: number;
  assessedAmountWon: number;
  reportedExemptionRate: number | null;
  computedExemptionRate: number | null;
  isAggregate: boolean;
}

export interface NormalizedTaxUnrefunded extends TaxSourceRow {
  taxCategory: string;
  unrefundedType: string;
  taxpayerType: string;
  currentCount: number;
  currentAmountWon: number;
  cumulativeCount: number;
  cumulativeAmountWon: number;
  reportedCumulativeChange: number | null;
  isAggregate: boolean;
}

export interface NormalizedTaxEnforcement extends TaxSourceRow {
  enforcementDate: string;
  agency: string;
  delinquencyCount: number;
  delinquencyAmountWon: number;
}

export interface NormalizedHeadlineTaxRevenue {
  regionId: string;
  regionName: string;
  fiscalYear: number;
  taxCategory: string;
  revenueAmountWon: number;
  accountingBasis: "settlement" | "reported";
  amountSemantics:
    | "collected_amount"
    | "payment_amount"
    | "reported_total_tax_burden";
  sourceGrain: "collection_status" | "payment_media" | "per_capita_burden";
  unitOriginal: TaxUnitOriginal;
  unitMultiplier: 1 | 1000;
  unitProvenance: TaxUnitProvenance;
  isAggregate: boolean;
  sourcePath: string;
  sourceSha256: string;
  sourceRow: number;
  metadata: Record<string, unknown>;
}

export interface LocalTaxNormalizationResult {
  collection: NormalizedTaxCollection[];
  paymentMedia: NormalizedTaxPaymentMedia[];
  assessment: NormalizedTaxAssessment[];
  perCapita: NormalizedTaxPerCapita[];
  taxpayer: NormalizedTaxpayerStatus[];
  exemption: NormalizedTaxExemption[];
  unrefunded: NormalizedTaxUnrefunded[];
  enforcement: NormalizedTaxEnforcement[];
  headlineRevenue: NormalizedHeadlineTaxRevenue[];
  qualityIssues: TaxQualityIssue[];
  reconciliations: TaxReconciliation[];
  excludedPropertyRows: number;
  quarantinedRows: number;
}

const clean = (value: string): string =>
  value.normalize("NFC").replace(/^\uFEFF/u, "").trim();

const headerSet = (headers: string[]): Set<string> =>
  new Set(headers.map(clean));

function hasAll(headers: Set<string>, values: string[]): boolean {
  return values.every((value) => headers.has(value));
}

export function detectLocalTaxCsvKind(
  headers: string[]
): LocalTaxCsvKind | null {
  const values = headerSet(headers);
  if (hasAll(values, ["법정동", "물건지", "시가표준액"])) {
    return "property_valuation_microdata";
  }
  if (
    values.has("세목명") &&
    [...values].some((value) => value.includes("수납급액")) &&
    [...values].some((value) => value.includes("부과금액"))
  ) {
    return "local_tax_collection";
  }
  if (hasAll(values, ["세목명", "납부건수", "납부금액"])) {
    return "local_tax_payment_media";
  }
  if (
    hasAll(values, ["세목명", "과세건수", "과세금액", "비과세건수", "비과세금액"])
  ) {
    return "local_tax_assessment";
  }
  if (
    hasAll(values, [
      "과세년도",
      "주민1인당 부담금액",
      "세대당부담금액",
      "지방세 금액"
    ])
  ) {
    return "local_tax_per_capita";
  }
  if (hasAll(values, ["과세년도", "세목명", "납세자유형", "납세자수"])) {
    return "local_tax_taxpayer";
  }
  if (
    values.has("세목명") &&
    [...values].some((value) => value.includes("비과세금액")) &&
    [...values].some((value) => value.includes("감면금액")) &&
    [...values].some((value) => value.includes("부과금액"))
  ) {
    return "local_tax_exemption";
  }
  if (
    hasAll(values, ["연도", "구분", "세액", "건수", "법령"])
  ) {
    return "local_tax_exemption_unverified";
  }
  if (
    hasAll(values, [
      "세목명",
      "과세년도",
      "미환급유형",
      "당해미환급건수",
      "누적미환급금액"
    ])
  ) {
    return "local_tax_unrefunded";
  }
  if (hasAll(values, ["영치일", "영치기관", "체납건수", "체납액"])) {
    return "local_tax_enforcement";
  }
  return null;
}

export function emptyLocalTaxNormalization(): LocalTaxNormalizationResult {
  return {
    collection: [],
    paymentMedia: [],
    assessment: [],
    perCapita: [],
    taxpayer: [],
    exemption: [],
    unrefunded: [],
    enforcement: [],
    headlineRevenue: [],
    qualityIssues: [],
    reconciliations: [],
    excludedPropertyRows: 0,
    quarantinedRows: 0
  };
}

function value(row: Record<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const key = Object.keys(row).find((candidate) => clean(candidate) === alias);
    if (key && row[key] !== undefined) return clean(row[key]!);
  }
  return "";
}

function matchingHeader(headers: string[], aliases: string[]): string | null {
  return (
    headers.find((header) =>
      aliases.some((alias) => clean(header).includes(alias))
    ) ?? null
  );
}

function numeric(valueToParse: string): number | null {
  const compact = valueToParse.replace(/[,\s%]/gu, "");
  if (!compact || !/^-?\d+(?:\.\d+)?$/u.test(compact)) return null;
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(valueToParse: string): number | null {
  const parsed = numeric(valueToParse);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseTaxYear(
  valueToParse: string,
  options: { allowTwoDigit?: boolean; currentYear?: number } = {}
): number | null {
  const parsed = integer(valueToParse);
  if (parsed === null) return null;
  const expanded =
    options.allowTwoDigit === true && parsed >= 0 && parsed <= 99
      ? 2000 + parsed
      : parsed;
  const maximum = (options.currentYear ?? new Date().getUTCFullYear()) + 1;
  return expanded >= 2000 && expanded <= maximum ? expanded : null;
}

function parseIsoDate(valueToParse: string): string | null {
  const match = valueToParse.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const date = new Date(`${valueToParse}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== valueToParse
    ? null
    : valueToParse;
}

function isAggregateCategory(valueToCheck: string): boolean {
  return ["합계", "총계", "소계", "계"].includes(
    valueToCheck.replace(/\s+/gu, "")
  );
}

function unitFromHeaders(headers: string[]): {
  unitOriginal: TaxUnitOriginal;
  unitMultiplier: 1 | 1000;
  unitProvenance: TaxUnitProvenance;
} {
  const moneyHeaders = headers.filter((header) =>
    /금액|세액|부담액|체납액/u.test(header)
  );
  if (moneyHeaders.some((header) => /천원/u.test(header))) {
    return {
      unitOriginal: "thousand_KRW",
      unitMultiplier: 1000,
      unitProvenance: "explicit_header_thousand_krw"
    };
  }

  if (moneyHeaders.some((header) => /\(원\)|\b원\b/u.test(header))) {
    return {
      unitOriginal: "KRW",
      unitMultiplier: 1,
      unitProvenance: "explicit_header_krw"
    };
  }
  return {
    unitOriginal: "KRW",
    unitMultiplier: 1,
    unitProvenance: "unmarked_header_default_krw"
  };
}

function sourceUnitFromHeaders(
  source: LocalTaxSourceInput,
  issues: TaxQualityIssue[]
): ReturnType<typeof unitFromHeaders> {
  const moneyHeaders = source.headers.filter((header) =>
    /금액|세액|부담액|체납액/u.test(header)
  );
  const hasThousandKrw = moneyHeaders.some((header) => /천원/u.test(header));
  const hasKrw = moneyHeaders.some((header) => /\(원\)|\b원\b/u.test(header));
  if (hasThousandKrw && hasKrw) {
    issue(issues, source, {
      severity: "error",
      issueCode: "conflicting_money_units",
      entityType: source.kind,
      sourceRow: null,
      fieldName: null,
      message: "Money headers declare conflicting KRW and thousand-KRW units",
      observed: moneyHeaders,
      expected: "One consistent monetary unit per source",
      quarantined: true
    });
  }
  return unitFromHeaders(source.headers);
}

function money(valueToParse: string, multiplier: 1 | 1000): number | null {
  const parsed = integer(valueToParse);
  if (parsed === null || parsed < 0) return null;
  const won = parsed * multiplier;
  return Number.isSafeInteger(won) ? won : null;
}

function regionByCode(code: string): GyeongbukRegion | null {
  return GYEONGBUK_REGIONS.find((region) => region.regionId === code) ?? null;
}

export function resolveTaxRegionIdentity(input: {
  regionCode?: string;
  regionName?: string;
  sourcePath?: string;
}): {
  region: GyeongbukRegion | null;
  error: string | null;
} {
  const code = clean(input.regionCode ?? "");
  const name = clean(input.regionName ?? "");
  const byCode = code ? regionByCode(code) : null;
  const byName = name ? resolveGyeongbukRegion(name) : null;
  if (code && !byCode) {
    return { region: null, error: `Unknown canonical municipality code: ${code}` };
  }
  if (byCode && name && byName?.regionId !== byCode.regionId) {
    return {
      region: null,
      error: `Municipality code/name mismatch: ${code}/${name}`
    };
  }
  const region = byCode ?? byName ?? inferGyeongbukRegion(input.sourcePath);
  return region
    ? { region, error: null }
    : { region: null, error: "Unresolved canonical Gyeongbuk municipality" };
}

function issue(
  issues: TaxQualityIssue[],
  source: LocalTaxSourceInput,
  partial: Omit<TaxQualityIssue, "sourcePath" | "sourceSha256">
): void {
  issues.push({
    ...partial,
    sourcePath: source.path,
    sourceSha256: source.sha256
  });
}

function rowRegion(
  source: LocalTaxSourceInput,
  row: Record<string, string>,
  sourceRow: number,
  issues: TaxQualityIssue[],
  codeAliases = ["자치단체코드"],
  nameAliases = ["시군구명"]
): GyeongbukRegion | null {
  const resolved = resolveTaxRegionIdentity({
    regionCode: value(row, codeAliases),
    regionName: value(row, nameAliases),
    sourcePath: source.path
  });
  if (resolved.region) return resolved.region;
  issue(issues, source, {
    severity: "error",
    issueCode: "unresolved_region",
    entityType: source.kind,
    sourceRow,
    fieldName: "자치단체코드",
    message: resolved.error!,
    observed: {
      code: value(row, codeAliases),
      name: value(row, nameAliases)
    },
    expected: "Canonical Gyeongbuk municipality code/name",
    quarantined: true
  });
  return null;
}

function requiredYear(
  source: LocalTaxSourceInput,
  row: Record<string, string>,
  sourceRow: number,
  issues: TaxQualityIssue[],
  aliases: string[],
  allowTwoDigit = false
): number | null {
  const raw = value(row, aliases);
  const year = parseTaxYear(raw, { allowTwoDigit });
  if (year !== null) return year;
  issue(issues, source, {
    severity: "error",
    issueCode: "invalid_year",
    entityType: source.kind,
    sourceRow,
    fieldName: aliases[0]!,
    message: "Tax year is outside the validated 2000..current+1 range",
    observed: raw,
    expected: allowTwoDigit
      ? "YYYY or two-digit YY mapped to 20YY within range"
      : "Four-digit year within range",
    quarantined: true
  });
  return null;
}

function requiredInteger(
  source: LocalTaxSourceInput,
  row: Record<string, string>,
  sourceRow: number,
  issues: TaxQualityIssue[],
  aliases: string[],
  options: { nonNegative?: boolean } = {}
): number | null {
  const raw = value(row, aliases);
  const parsed = integer(raw);
  if (
    parsed !== null &&
    (options.nonNegative !== true || parsed >= 0)
  ) {
    return parsed;
  }
  issue(issues, source, {
    severity: "error",
    issueCode: "invalid_integer",
    entityType: source.kind,
    sourceRow,
    fieldName: aliases[0]!,
    message: "Expected a safe integer value",
    observed: raw,
    expected: options.nonNegative ? "Non-negative integer" : "Integer",
    quarantined: true
  });
  return null;
}

function requiredMoney(
  source: LocalTaxSourceInput,
  row: Record<string, string>,
  sourceRow: number,
  issues: TaxQualityIssue[],
  aliases: string[],
  multiplier: 1 | 1000
): number | null {
  const raw = value(row, aliases);
  const parsed = money(raw, multiplier);
  if (parsed !== null) return parsed;
  issue(issues, source, {
    severity: "error",
    issueCode: "invalid_money",
    entityType: source.kind,
    sourceRow,
    fieldName: aliases[0]!,
    message: "Expected a non-negative safe KRW integer",
    observed: raw,
    expected: `Non-negative integer x ${multiplier}`,
    quarantined: true
  });
  return null;
}

function optionalInteger(
  source: LocalTaxSourceInput,
  row: Record<string, string>,
  sourceRow: number,
  issues: TaxQualityIssue[],
  aliases: string[]
): number | null {
  const raw = value(row, aliases);
  if (!raw) return null;
  return requiredInteger(source, row, sourceRow, issues, aliases, {
    nonNegative: true
  });
}

function optionalMoney(
  source: LocalTaxSourceInput,
  row: Record<string, string>,
  sourceRow: number,
  issues: TaxQualityIssue[],
  aliases: string[],
  multiplier: 1 | 1000
): number | null {
  const raw = value(row, aliases);
  if (!raw) return null;
  return requiredMoney(source, row, sourceRow, issues, aliases, multiplier);
}

function stableValue(valueToHash: unknown): string {
  if (Array.isArray(valueToHash)) {
    return `[${valueToHash.map(stableValue).join(",")}]`;
  }
  if (valueToHash && typeof valueToHash === "object") {
    return `{${Object.entries(valueToHash as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableValue(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(valueToHash);
}

function withoutSourceRow<T extends { sourceRow: number }>(
  row: T
): Omit<T, "sourceRow"> {
  const { sourceRow: _sourceRow, ...rest } = row;
  return rest;
}

function dedupe<T extends { sourcePath: string; sourceSha256: string; sourceRow: number }>(
  rows: T[],
  key: (row: T) => string,
  entityType: string,
  issues: TaxQualityIssue[]
): T[] {
  const selected = new Map<string, T>();
  for (const row of rows) {
    const naturalKey = key(row);
    const existing = selected.get(naturalKey);
    if (!existing) {
      selected.set(naturalKey, row);
      continue;
    }
    const identical =
      stableValue(withoutSourceRow(existing)) ===
      stableValue(withoutSourceRow(row));
    issues.push({
      severity: identical ? "warning" : "error",
      issueCode: identical
        ? "duplicate_natural_key_identical"
        : "duplicate_natural_key_conflict",
      entityType,
      sourcePath: row.sourcePath,
      sourceSha256: row.sourceSha256,
      sourceRow: row.sourceRow,
      fieldName: null,
      message: identical
        ? "Duplicate natural key has identical values; later row was skipped"
        : "Duplicate natural key has conflicting values",
      observed: { naturalKey, firstRow: existing.sourceRow, duplicateRow: row.sourceRow },
      expected: "One row per natural key",
      quarantined: true
    });
  }
  return [...selected.values()];
}

function collectionRawKey(
  regionId: string,
  fiscalYear: number,
  taxCategory: string
): string {
  return `${regionId}:${fiscalYear}:${taxCategory.replace(/\s+/gu, "")}`;
}

function sourceUnit(
  source: LocalTaxSourceInput,
  collections: NormalizedTaxCollection[],
  issues: TaxQualityIssue[]
): ReturnType<typeof unitFromHeaders> {
  const detected = sourceUnitFromHeaders(source, issues);
  const hasPaymentMedia = source.headers.some(
    (header) => clean(header) === "납부매체"
  );
  if (
    source.kind !== "local_tax_payment_media" ||
    detected.unitProvenance !== "unmarked_header_default_krw" ||
    hasPaymentMedia
  ) {
    return detected;
  }

  const matches = new Set<string>();
  for (const row of source.rows) {
    const region = resolveTaxRegionIdentity({
      regionCode: value(row, ["자치단체코드"]),
      regionName: value(row, ["시군구명"]),
      sourcePath: source.path
    }).region;
    const fiscalYear = parseTaxYear(value(row, ["납부년도"]));
    const category = clean(value(row, ["세목명"]));
    const rawPayment = integer(value(row, ["납부금액"]));
    if (!region || !fiscalYear || !category || rawPayment === null) continue;
    const collection = collections.find(
      (candidate) =>
        collectionRawKey(
          candidate.regionId,
          candidate.fiscalYear,
          candidate.taxCategory
        ) === collectionRawKey(region.regionId, fiscalYear, category) &&
        candidate.unitMultiplier === 1000 &&
        candidate.collectedAmountWon / 1000 === rawPayment
    );
    if (collection) matches.add(category);
  }
  if (matches.size < 3) return detected;
  issue(issues, source, {
    severity: "info",
    issueCode: "payment_unit_inferred_by_collection_reconciliation",
    entityType: source.kind,
    sourceRow: null,
    fieldName: "납부금액",
    message:
      "Unmarked payment amounts were converted from thousand KRW after exact cross-source category reconciliation",
    observed: { matchedCategoryCount: matches.size, categories: [...matches].sort() },
    expected: "At least three exact matches to an explicit thousand-KRW collection source",
    quarantined: false
  });
  return {
    unitOriginal: "thousand_KRW",
    unitMultiplier: 1000,
    unitProvenance: "cross_source_reconciliation_thousand_krw"
  };
}

export function normalizeLocalTaxSources(
  inputs: LocalTaxSourceInput[]
): LocalTaxNormalizationResult {
  const result = emptyLocalTaxNormalization();
  const sources = [...inputs].sort((left, right) =>
    left.path.localeCompare(right.path)
  );

  for (const source of sources.filter(
    (candidate) => candidate.kind === "local_tax_collection"
  )) {
    const unit = sourceUnitFromHeaders(source, result.qualityIssues);
    const assessedHeader = matchingHeader(source.headers, ["부과금액"]);
    const collectedHeader = matchingHeader(source.headers, ["수납급액"]);
    const refundHeader = matchingHeader(source.headers, ["환급금액"]);
    const writtenOffHeader = matchingHeader(source.headers, [
      "결손금액",
      "정리보류액"
    ]);
    const uncollectedHeader = matchingHeader(source.headers, ["미수납 금액"]);
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index]!;
      const sourceRow = index + 2;
      const region = rowRegion(source, row, sourceRow, result.qualityIssues);
      const fiscalYear = requiredYear(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["과세년도"]
      );
      const taxCategory = clean(value(row, ["세목명"]));
      const assessedAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        [assessedHeader ?? "부과금액"],
        unit.unitMultiplier
      );
      const collectedAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        [collectedHeader ?? "수납급액"],
        unit.unitMultiplier
      );
      const refundedAmountWon = optionalMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        [refundHeader ?? "환급금액"],
        unit.unitMultiplier
      );
      const writtenOffAmountWon = optionalMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        [writtenOffHeader ?? "결손금액"],
        unit.unitMultiplier
      );
      const uncollectedAmountWon = optionalMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        [uncollectedHeader ?? "미수납 금액"],
        unit.unitMultiplier
      );
      if (
        !region ||
        !fiscalYear ||
        !taxCategory ||
        assessedAmountWon === null ||
        collectedAmountWon === null
      ) {
        continue;
      }
      const missingMeasures = [
        [refundHeader ?? "환급금액", refundedAmountWon],
        [writtenOffHeader ?? "결손금액", writtenOffAmountWon],
        [uncollectedHeader ?? "미수납 금액", uncollectedAmountWon]
      ]
        .filter(([, amount]) => amount === null)
        .map(([field]) => field);
      if (missingMeasures.length > 0) {
        issue(result.qualityIssues, source, {
          severity: "warning",
          issueCode: "partial_collection_measures",
          entityType: source.kind,
          sourceRow,
          fieldName: null,
          message: "Optional collection measures are blank and remain NULL",
          observed: { missingFields: missingMeasures },
          expected: "Blank means unavailable, not zero",
          quarantined: false
        });
      }
      const reportedCollectionRate = numeric(value(row, ["징수율"]));
      const computedCollectionRate =
        assessedAmountWon === 0
          ? null
          : Number(((collectedAmountWon / assessedAmountWon) * 100).toFixed(4));
      const collectionRateDifference =
        reportedCollectionRate !== null && computedCollectionRate !== null
          ? Math.abs(reportedCollectionRate - computedCollectionRate)
          : null;
      if (
        collectionRateDifference !== null &&
        collectionRateDifference > 0.2
      ) {
        const consistentWithIntegerReporting =
          Number.isInteger(reportedCollectionRate) &&
          collectionRateDifference <= 1;
        issue(result.qualityIssues, source, {
          severity: consistentWithIntegerReporting ? "info" : "warning",
          issueCode: "collection_rate_mismatch",
          entityType: source.kind,
          sourceRow,
          fieldName: "징수율",
          message: consistentWithIntegerReporting
            ? "Reported integer collection rate differs by at most one percentage point, consistent with publisher rounding or truncation"
            : "Reported collection rate differs materially from collected/assessed",
          observed: reportedCollectionRate,
          expected: {
            computedCollectionRate,
            validationTolerancePercentagePoints: Number.isInteger(
              reportedCollectionRate
            )
              ? 1
              : 0.2
          },
          quarantined: false
        });
      }
      if (
        assessedAmountWon === 0 &&
        collectedAmountWon === 0 &&
        (refundedAmountWon ?? 0) === 0 &&
        (writtenOffAmountWon ?? 0) === 0 &&
        (uncollectedAmountWon ?? 0) === 0
      ) {
        issue(result.qualityIssues, source, {
          severity: "warning",
          issueCode: "zero_only_row",
          entityType: source.kind,
          sourceRow,
          fieldName: null,
          message: "All monetary measures are zero",
          observed: taxCategory,
          expected: "A supported zero activity row or a non-zero measure",
          quarantined: false
        });
      }
      result.collection.push({
        regionId: region.regionId,
        regionName: region.regionName,
        fiscalYear,
        taxCategory,
        assessedAmountWon,
        collectedAmountWon,
        refundedAmountWon,
        writtenOffAmountWon,
        uncollectedAmountWon,
        reportedCollectionRate,
        computedCollectionRate,
        isAggregate: isAggregateCategory(taxCategory),
        sourcePath: source.path,
        sourceSha256: source.sha256,
        sourceRow,
        ...unit
      });
    }
  }

  for (const source of sources.filter(
    (candidate) => candidate.kind === "local_tax_payment_media"
  )) {
    const unit = sourceUnit(source, result.collection, result.qualityIssues);
    const hasPaymentMedia = source.headers.some(
      (header) => clean(header) === "납부매체"
    );
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index]!;
      const sourceRow = index + 2;
      const region = rowRegion(source, row, sourceRow, result.qualityIssues);
      const fiscalYear = requiredYear(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["납부년도"]
      );
      const taxCategory = clean(value(row, ["세목명"]));
      const paymentCount = requiredInteger(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["납부건수"],
        { nonNegative: true }
      );
      const paymentAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["납부금액"],
        unit.unitMultiplier
      );
      if (
        !region ||
        !fiscalYear ||
        !taxCategory ||
        paymentCount === null ||
        paymentAmountWon === null
      ) {
        continue;
      }
      const electronicRaw = value(row, ["납부매체전자고지여부"]).toUpperCase();
      result.paymentMedia.push({
        regionId: region.regionId,
        regionName: region.regionName,
        fiscalYear,
        taxCategory,
        paymentMethod: hasPaymentMedia
          ? clean(value(row, ["납부매체"])) || null
          : null,
        electronicNotice:
          electronicRaw === "Y" ? true : electronicRaw === "N" ? false : null,
        paymentCount,
        paymentAmountWon,
        reportedMediaShare: numeric(value(row, ["납부매체비율"])),
        isAggregate: isAggregateCategory(taxCategory),
        sourcePath: source.path,
        sourceSha256: source.sha256,
        sourceRow,
        ...unit
      });
    }
  }

  for (const source of sources.filter(
    (candidate) => candidate.kind === "local_tax_assessment"
  )) {
    const unit = sourceUnitFromHeaders(source, result.qualityIssues);
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index]!;
      const sourceRow = index + 2;
      const region = rowRegion(source, row, sourceRow, result.qualityIssues);
      const fiscalYear = requiredYear(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["과세년도"]
      );
      const taxCategory = clean(value(row, ["세목명"]));
      const assessedCount = optionalInteger(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["과세건수"]
      );
      const assessedAmountWon = optionalMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["과세금액"],
        unit.unitMultiplier
      );
      const nonTaxableCount = optionalInteger(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["비과세건수"]
      );
      const nonTaxableAmountWon = optionalMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["비과세금액"],
        unit.unitMultiplier
      );
      if (
        !region ||
        !fiscalYear ||
        !taxCategory
      ) {
        continue;
      }
      const measures = {
        assessedCount,
        assessedAmountWon,
        nonTaxableCount,
        nonTaxableAmountWon
      };
      const missingFields = Object.entries(measures)
        .filter(([, measure]) => measure === null)
        .map(([field]) => field);
      if (missingFields.length === Object.keys(measures).length) {
        issue(result.qualityIssues, source, {
          severity: "warning",
          issueCode: "empty_assessment_measures",
          entityType: source.kind,
          sourceRow,
          fieldName: null,
          message: "All assessment measures are blank; row was quarantined",
          observed: taxCategory,
          expected: "At least one assessment or non-taxable measure",
          quarantined: true
        });
        result.quarantinedRows += 1;
        continue;
      }
      if (missingFields.length > 0) {
        issue(result.qualityIssues, source, {
          severity: "warning",
          issueCode: "partial_assessment_measures",
          entityType: source.kind,
          sourceRow,
          fieldName: null,
          message: "Blank assessment measures remain NULL",
          observed: { missingFields },
          expected: "Blank means unavailable, not zero",
          quarantined: false
        });
      }
      result.assessment.push({
        regionId: region.regionId,
        regionName: region.regionName,
        fiscalYear,
        taxCategory,
        assessedCount,
        assessedAmountWon,
        nonTaxableCount,
        nonTaxableAmountWon,
        isAggregate: isAggregateCategory(taxCategory),
        sourcePath: source.path,
        sourceSha256: source.sha256,
        sourceRow,
        ...unit
      });
    }
  }

  for (const source of sources.filter(
    (candidate) => candidate.kind === "local_tax_per_capita"
  )) {
    const unit = sourceUnitFromHeaders(source, result.qualityIssues);
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index]!;
      const sourceRow = index + 2;
      if (Object.values(row).every((cell) => clean(cell) === "")) {
        issue(result.qualityIssues, source, {
          severity: "info",
          issueCode: "empty_row_skipped",
          entityType: source.kind,
          sourceRow,
          fieldName: null,
          message: "Empty trailing row was skipped",
          observed: null,
          expected: "A populated burden row",
          quarantined: true
        });
        continue;
      }
      const region = rowRegion(source, row, sourceRow, result.qualityIssues);
      const fiscalYear = requiredYear(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["과세년도"]
      );
      const perResidentAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["주민1인당 부담금액"],
        unit.unitMultiplier
      );
      const perHouseholdAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["세대당부담금액"],
        unit.unitMultiplier
      );
      const totalLocalTaxAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["지방세 금액"],
        unit.unitMultiplier
      );
      if (
        !region ||
        !fiscalYear ||
        perResidentAmountWon === null ||
        perHouseholdAmountWon === null ||
        totalLocalTaxAmountWon === null
      ) {
        continue;
      }
      const populationCount = integer(value(row, ["인구수"]));
      const householdCount = integer(value(row, ["세대수"]));
      result.perCapita.push({
        regionId: region.regionId,
        regionName: region.regionName,
        fiscalYear,
        perResidentAmountWon,
        perHouseholdAmountWon,
        totalLocalTaxAmountWon,
        populationCount:
          populationCount !== null && populationCount >= 0
            ? populationCount
            : null,
        householdCount:
          householdCount !== null && householdCount >= 0
            ? householdCount
            : null,
        sourcePath: source.path,
        sourceSha256: source.sha256,
        sourceRow,
        ...unit
      });
    }
  }

  for (const source of sources.filter(
    (candidate) => candidate.kind === "local_tax_taxpayer"
  )) {
    const unit = sourceUnitFromHeaders(source, result.qualityIssues);
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index]!;
      const sourceRow = index + 2;
      const region = rowRegion(source, row, sourceRow, result.qualityIssues);
      const fiscalYear = requiredYear(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["과세년도"]
      );
      const taxCategory = clean(value(row, ["세목명"]));
      const taxpayerType = clean(value(row, ["납세자유형"]));
      const jurisdictionScope = clean(value(row, ["관내_관외"]));
      const taxpayerCount = requiredInteger(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["납세자수"],
        { nonNegative: true }
      );
      if (
        !region ||
        !fiscalYear ||
        !taxCategory ||
        !taxpayerType ||
        !jurisdictionScope ||
        taxpayerCount === null
      ) {
        continue;
      }
      result.taxpayer.push({
        regionId: region.regionId,
        regionName: region.regionName,
        fiscalYear,
        taxCategory,
        taxpayerType,
        jurisdictionScope,
        taxpayerCount,
        isAggregate: isAggregateCategory(taxCategory),
        sourcePath: source.path,
        sourceSha256: source.sha256,
        sourceRow,
        ...unit
      });
    }
  }

  for (const source of sources.filter(
    (candidate) => candidate.kind === "local_tax_exemption"
  )) {
    const unit = sourceUnitFromHeaders(source, result.qualityIssues);
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index]!;
      const sourceRow = index + 2;
      const region = rowRegion(source, row, sourceRow, result.qualityIssues);
      const fiscalYear = requiredYear(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["과세년도"],
        true
      );
      const taxCategory = clean(value(row, ["세목명"]));
      const nonTaxableAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["비과세금액(원)", "비과세금액"],
        unit.unitMultiplier
      );
      const reductionAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["감면금액(원)", "감면금액"],
        unit.unitMultiplier
      );
      const assessedAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["부과금액(원)", "부과금액"],
        unit.unitMultiplier
      );
      if (
        !region ||
        !fiscalYear ||
        !taxCategory ||
        nonTaxableAmountWon === null ||
        reductionAmountWon === null ||
        assessedAmountWon === null
      ) {
        continue;
      }
      const reportedExemptionRate = numeric(
        value(row, ["비과세감면율(퍼센트)", "비과세감면율"])
      );
      const computedExemptionRate =
        assessedAmountWon === 0
          ? null
          : Number(
              (
                ((nonTaxableAmountWon + reductionAmountWon) /
                  assessedAmountWon) *
                100
              ).toFixed(4)
            );
      result.exemption.push({
        regionId: region.regionId,
        regionName: region.regionName,
        fiscalYear,
        taxCategory,
        nonTaxableAmountWon,
        reductionAmountWon,
        assessedAmountWon,
        reportedExemptionRate,
        computedExemptionRate,
        isAggregate: isAggregateCategory(taxCategory),
        sourcePath: source.path,
        sourceSha256: source.sha256,
        sourceRow,
        ...unit
      });
    }
  }

  for (const source of sources.filter(
    (candidate) => candidate.kind === "local_tax_unrefunded"
  )) {
    const unit = sourceUnitFromHeaders(source, result.qualityIssues);
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index]!;
      const sourceRow = index + 2;
      const region = rowRegion(source, row, sourceRow, result.qualityIssues);
      const fiscalYear = requiredYear(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["과세년도"]
      );
      const taxCategory = clean(value(row, ["세목명"]));
      const currentCount = requiredInteger(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["당해미환급건수"],
        { nonNegative: true }
      );
      const currentAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["당해미환급금액"],
        unit.unitMultiplier
      );
      const cumulativeCount = requiredInteger(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["누적미환급건수"],
        { nonNegative: true }
      );
      const cumulativeAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["누적미환급금액"],
        unit.unitMultiplier
      );
      if (
        !region ||
        !fiscalYear ||
        !taxCategory ||
        currentCount === null ||
        currentAmountWon === null ||
        cumulativeCount === null ||
        cumulativeAmountWon === null
      ) {
        continue;
      }
      result.unrefunded.push({
        regionId: region.regionId,
        regionName: region.regionName,
        fiscalYear,
        taxCategory,
        unrefundedType: clean(value(row, ["미환급유형"])),
        taxpayerType: clean(value(row, ["납세자유형"])),
        currentCount,
        currentAmountWon,
        cumulativeCount,
        cumulativeAmountWon,
        reportedCumulativeChange: numeric(
          value(row, ["누적미환급금액증감"])
        ),
        isAggregate: isAggregateCategory(taxCategory),
        sourcePath: source.path,
        sourceSha256: source.sha256,
        sourceRow,
        ...unit
      });
    }
  }

  for (const source of sources.filter(
    (candidate) => candidate.kind === "local_tax_enforcement"
  )) {
    const unit = sourceUnitFromHeaders(source, result.qualityIssues);
    issue(result.qualityIssues, source, {
      severity: "info",
      issueCode: "enforcement_location_omitted",
      entityType: source.kind,
      sourceRow: null,
      fieldName: "영치장소",
      message:
        "Location strings were intentionally omitted; only enforcement statistics are normalized",
      observed: { rowCount: source.rows.length },
      expected: "No location text in analytics tables or tool responses",
      quarantined: false
    });
    for (let index = 0; index < source.rows.length; index += 1) {
      const row = source.rows[index]!;
      const sourceRow = index + 2;
      const region = rowRegion(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["영치기관코드"],
        ["영치기관"]
      );
      const enforcementDate = parseIsoDate(value(row, ["영치일"]));
      const fiscalYear = enforcementDate
        ? Number(enforcementDate.slice(0, 4))
        : null;
      const delinquencyCount = requiredInteger(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["체납건수"],
        { nonNegative: true }
      );
      const delinquencyAmountWon = requiredMoney(
        source,
        row,
        sourceRow,
        result.qualityIssues,
        ["체납액"],
        unit.unitMultiplier
      );
      if (
        !region ||
        !enforcementDate ||
        !fiscalYear ||
        delinquencyCount === null ||
        delinquencyAmountWon === null
      ) {
        if (!enforcementDate) {
          issue(result.qualityIssues, source, {
            severity: "error",
            issueCode: "invalid_enforcement_date",
            entityType: source.kind,
            sourceRow,
            fieldName: "영치일",
            message: "Enforcement date is invalid",
            observed: value(row, ["영치일"]),
            expected: "YYYY-MM-DD",
            quarantined: true
          });
        }
        continue;
      }
      result.enforcement.push({
        regionId: region.regionId,
        regionName: region.regionName,
        fiscalYear,
        enforcementDate,
        agency: clean(value(row, ["영치기관"])),
        delinquencyCount,
        delinquencyAmountWon,
        sourcePath: source.path,
        sourceSha256: source.sha256,
        sourceRow,
        ...unit
      });
    }
  }

  for (const source of sources.filter(
    (candidate) => candidate.kind === "local_tax_exemption_unverified"
  )) {
    const anomalousRows = source.rows
      .map((row, index) => ({
        sourceRow: index + 2,
        amount: integer(value(row, ["세액"])),
        count: integer(value(row, ["건수"]))
      }))
      .filter(
        (row) =>
          row.amount !== null &&
          row.count !== null &&
          row.count > 1_000_000 &&
          row.amount < 100_000
      );
    issue(result.qualityIssues, source, {
      severity: "warning",
      issueCode: "unverified_column_semantics_quarantined",
      entityType: source.kind,
      sourceRow: null,
      fieldName: "세액/건수",
      message:
        "Amount/count columns show implausible scale ordering; rows were quarantined without swapping",
      observed: {
        rowCount: source.rows.length,
        anomalousRowCount: anomalousRows.length,
        sampleRows: anomalousRows.slice(0, 10).map((row) => row.sourceRow)
      },
      expected: "Verified publisher schema or corrected source",
      quarantined: true
    });
    result.quarantinedRows += source.rows.length;
  }

  for (const source of sources.filter(
    (candidate) => candidate.kind === "property_valuation_microdata"
  )) {
    issue(result.qualityIssues, source, {
      severity: "info",
      issueCode: "property_microdata_privacy_excluded",
      entityType: source.kind,
      sourceRow: null,
      fieldName: null,
      message:
        "Address-level property valuations were catalogued but excluded from analytics, search, and embeddings",
      observed: { rowCount: source.rows.length, addressColumnsPresent: true },
      expected: "Separate approved access-control design before any row-level load",
      quarantined: true
    });
    result.excludedPropertyRows += source.rows.length;
  }

  result.collection = dedupe(
    result.collection,
    (row) =>
      `${row.sourcePath}:${row.regionId}:${row.fiscalYear}:${row.taxCategory}`,
    "local_tax_collection",
    result.qualityIssues
  );
  result.paymentMedia = dedupe(
    result.paymentMedia,
    (row) =>
      [
        row.sourcePath,
        row.regionId,
        row.fiscalYear,
        row.taxCategory,
        row.paymentMethod ?? "",
        row.electronicNotice === null ? "" : String(row.electronicNotice)
      ].join(":"),
    "local_tax_payment_media",
    result.qualityIssues
  );
  result.assessment = dedupe(
    result.assessment,
    (row) =>
      `${row.sourcePath}:${row.regionId}:${row.fiscalYear}:${row.taxCategory}`,
    "local_tax_assessment",
    result.qualityIssues
  );
  result.perCapita = dedupe(
    result.perCapita,
    (row) => `${row.sourcePath}:${row.regionId}:${row.fiscalYear}`,
    "local_tax_per_capita",
    result.qualityIssues
  );
  result.taxpayer = dedupe(
    result.taxpayer,
    (row) =>
      [
        row.sourcePath,
        row.regionId,
        row.fiscalYear,
        row.taxCategory,
        row.taxpayerType,
        row.jurisdictionScope
      ].join(":"),
    "local_tax_taxpayer",
    result.qualityIssues
  );
  result.exemption = dedupe(
    result.exemption,
    (row) =>
      `${row.sourcePath}:${row.regionId}:${row.fiscalYear}:${row.taxCategory}`,
    "local_tax_exemption",
    result.qualityIssues
  );
  result.unrefunded = dedupe(
    result.unrefunded,
    (row) =>
      [
        row.sourcePath,
        row.regionId,
        row.fiscalYear,
        row.taxCategory,
        row.unrefundedType,
        row.taxpayerType
      ].join(":"),
    "local_tax_unrefunded",
    result.qualityIssues
  );

  const collectionGroups = new Map<string, NormalizedTaxCollection[]>();
  for (const row of result.collection) {
    const key = `${row.regionId}:${row.fiscalYear}`;
    collectionGroups.set(key, [...(collectionGroups.get(key) ?? []), row]);
    result.headlineRevenue.push({
      regionId: row.regionId,
      regionName: row.regionName,
      fiscalYear: row.fiscalYear,
      taxCategory: row.taxCategory,
      revenueAmountWon: row.collectedAmountWon,
      accountingBasis: "settlement",
      amountSemantics: "collected_amount",
      sourceGrain: "collection_status",
      unitOriginal: row.unitOriginal,
      unitMultiplier: row.unitMultiplier,
      unitProvenance: row.unitProvenance,
      isAggregate: row.isAggregate,
      sourcePath: row.sourcePath,
      sourceSha256: row.sourceSha256,
      sourceRow: row.sourceRow,
      metadata: { derived: false }
    });
  }
  for (const [key, rows] of collectionGroups) {
    const aggregateRows = rows.filter((row) => row.isAggregate);
    const detailRows = rows.filter((row) => !row.isAggregate);
    if (aggregateRows.length > 1) {
      const first = aggregateRows[0]!;
      result.qualityIssues.push({
        severity: "error",
        issueCode: "multiple_collection_aggregates",
        entityType: "local_tax_collection",
        sourcePath: first.sourcePath,
        sourceSha256: first.sourceSha256,
        sourceRow: first.sourceRow,
        fieldName: "세목명",
        message: "Multiple aggregate rows exist for one region/year",
        observed: aggregateRows.map((row) => row.sourceRow),
        expected: "At most one aggregate row",
        quarantined: true
      });
      continue;
    }
    const detailSum = detailRows.reduce(
      (total, row) => total + row.collectedAmountWon,
      0
    );
    if (aggregateRows[0] && detailRows.length > 0) {
      const aggregate = aggregateRows[0];
      const matches = aggregate.collectedAmountWon === detailSum;
      result.reconciliations.push({
        reconciliationCode: "collection_aggregate_vs_detail",
        sourcePath: aggregate.sourcePath,
        regionId: aggregate.regionId,
        fiscalYear: aggregate.fiscalYear,
        status: matches ? "passed" : "warning",
        details: {
          aggregateAmountWon: aggregate.collectedAmountWon,
          detailSumWon: detailSum,
          differenceWon: aggregate.collectedAmountWon - detailSum,
          detailRows: detailRows.length
        }
      });
      if (!matches) {
        result.qualityIssues.push({
          severity: "error",
          issueCode: "collection_aggregate_mismatch",
          entityType: "local_tax_collection",
          sourcePath: aggregate.sourcePath,
          sourceSha256: aggregate.sourceSha256,
          sourceRow: aggregate.sourceRow,
          fieldName: "수납급액",
          message: "Aggregate collected amount does not equal detail sum",
          observed: aggregate.collectedAmountWon,
          expected: detailSum,
          quarantined: true
        });
      }
      continue;
    }
    if (aggregateRows[0]) continue;
    const first = detailRows[0];
    if (!first) continue;
    result.headlineRevenue.push({
      regionId: first.regionId,
      regionName: first.regionName,
      fiscalYear: first.fiscalYear,
      taxCategory: "합계",
      revenueAmountWon: detailSum,
      accountingBasis: "settlement",
      amountSemantics: "collected_amount",
      sourceGrain: "collection_status",
      unitOriginal: first.unitOriginal,
      unitMultiplier: first.unitMultiplier,
      unitProvenance: first.unitProvenance,
      isAggregate: true,
      sourcePath: first.sourcePath,
      sourceSha256: first.sourceSha256,
      sourceRow: first.sourceRow,
      metadata: {
        derived: true,
        derivedFromSourceRows: detailRows.map((row) => row.sourceRow)
      }
    });
  }

  const collectionYearKeys = new Set(collectionGroups.keys());
  for (const row of result.perCapita) {
    if (collectionYearKeys.has(`${row.regionId}:${row.fiscalYear}`)) continue;
    result.headlineRevenue.push({
      regionId: row.regionId,
      regionName: row.regionName,
      fiscalYear: row.fiscalYear,
      taxCategory: "합계",
      revenueAmountWon: row.totalLocalTaxAmountWon,
      accountingBasis: "reported",
      amountSemantics: "reported_total_tax_burden",
      sourceGrain: "per_capita_burden",
      unitOriginal: row.unitOriginal,
      unitMultiplier: row.unitMultiplier,
      unitProvenance: row.unitProvenance,
      isAggregate: true,
      sourcePath: row.sourcePath,
      sourceSha256: row.sourceSha256,
      sourceRow: row.sourceRow,
      metadata: { derived: false }
    });
  }

  const collectionCategoryKeys = new Set(
    result.collection.map((row) =>
      collectionRawKey(row.regionId, row.fiscalYear, row.taxCategory)
    )
  );
  const paymentGroups = new Map<string, NormalizedTaxPaymentMedia[]>();
  for (const row of result.paymentMedia) {
    const key = [
      row.sourcePath,
      row.regionId,
      row.fiscalYear,
      row.taxCategory
    ].join(":");
    paymentGroups.set(key, [...(paymentGroups.get(key) ?? []), row]);
  }
  for (const rows of paymentGroups.values()) {
    const first = rows[0]!;
    if (
      collectionCategoryKeys.has(
        collectionRawKey(first.regionId, first.fiscalYear, first.taxCategory)
      ) ||
      first.isAggregate
    ) {
      continue;
    }
    result.headlineRevenue.push({
      regionId: first.regionId,
      regionName: first.regionName,
      fiscalYear: first.fiscalYear,
      taxCategory: first.taxCategory,
      revenueAmountWon: rows.reduce(
        (total, row) => total + row.paymentAmountWon,
        0
      ),
      accountingBasis: "settlement",
      amountSemantics: "payment_amount",
      sourceGrain: "payment_media",
      unitOriginal: first.unitOriginal,
      unitMultiplier: first.unitMultiplier,
      unitProvenance: first.unitProvenance,
      isAggregate: false,
      sourcePath: first.sourcePath,
      sourceSha256: first.sourceSha256,
      sourceRow: first.sourceRow,
      metadata: {
        derived: rows.length > 1,
        derivedFromSourceRows: rows.map((row) => row.sourceRow)
      }
    });
  }

  const kimcheonCollection = result.collection.filter(
    (row) => row.regionId === "47150" && !row.isAggregate
  );
  const kimcheonPayment = result.paymentMedia.filter(
    (row) => row.regionId === "47150"
  );
  const exactCategories = kimcheonPayment
    .filter((payment) =>
      kimcheonCollection.some(
        (collection) =>
          collection.fiscalYear === payment.fiscalYear &&
          collection.taxCategory === payment.taxCategory &&
          collection.collectedAmountWon === payment.paymentAmountWon
      )
    )
    .map((row) => row.taxCategory)
    .sort();
  if (exactCategories.length > 0) {
    const first = kimcheonPayment[0]!;
    result.reconciliations.push({
      reconciliationCode: "payment_vs_collection_unit_evidence",
      sourcePath: first.sourcePath,
      regionId: first.regionId,
      fiscalYear: first.fiscalYear,
      status: exactCategories.length >= 3 ? "passed" : "warning",
      details: {
        exactCategoryCount: exactCategories.length,
        exactCategories,
        note:
          "The acquisition-tax payment category has no matching row in the supplied collection file; inference uses the shared categories only."
      }
    });
  }

  result.headlineRevenue = dedupe(
    result.headlineRevenue,
    (row) =>
      [
        row.sourcePath,
        row.regionId,
        row.fiscalYear,
        row.taxCategory,
        row.accountingBasis
      ].join(":"),
    "local_tax_revenue",
    result.qualityIssues
  );

  result.qualityIssues.sort((left, right) =>
    [
      left.sourcePath,
      left.sourceRow ?? 0,
      left.issueCode
    ]
      .join(":")
      .localeCompare(
        [right.sourcePath, right.sourceRow ?? 0, right.issueCode].join(":")
      )
  );
  result.reconciliations.sort((left, right) =>
    [left.sourcePath, left.fiscalYear, left.reconciliationCode]
      .join(":")
      .localeCompare(
        [right.sourcePath, right.fiscalYear, right.reconciliationCode].join(":")
      )
  );
  return result;
}

export function taxQualityIssueKey(issueValue: TaxQualityIssue): string {
  return `tax-quality-${createHash("sha256")
    .update(
      [
        issueValue.sourceSha256,
        issueValue.sourcePath.normalize("NFC"),
        issueValue.sourceRow ?? 0,
        issueValue.issueCode,
        issueValue.fieldName ?? ""
      ].join("\u0000")
    )
    .digest("hex")
    .slice(0, 40)}`;
}
