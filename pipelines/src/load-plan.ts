import { createHash } from "node:crypto";
import { extname } from "node:path";
import { parseReferenceDate } from "./dates.js";
import { containsMarkupSource } from "./gb-press-release.js";
import {
  type EtlResult,
  type OfficialCouncilRow,
  type OfficialPressReleaseRow,
  type OfficialPopulationRow
} from "./etl.js";
import {
  GYEONGBUK_REGIONS,
  resolveGyeongbukRegion,
  type GyeongbukRegion
} from "./regions.js";
import {
  taxQualityIssueKey,
  type NormalizedTaxAssessment,
  type NormalizedTaxCollection,
  type NormalizedTaxEnforcement,
  type NormalizedTaxExemption,
  type NormalizedTaxPaymentMedia,
  type NormalizedTaxPerCapita,
  type NormalizedTaxUnrefunded,
  type NormalizedTaxpayerStatus,
  type TaxQualityIssue
} from "./local-tax.js";
import type {
  PopulationMeasurementBasis,
  ReferenceDatePrecision
} from "./population.js";

export type DataStatus = "official_observed" | "demo_sample" | "catalog_only";

export interface PlannedRegion {
  regionId: string;
  regionName: string;
  regionType: "province" | "city" | "county";
  parentRegionId: string | null;
  normalizedName: string;
}

export interface PlannedSource {
  sourceKey: string;
  title: string;
  provider: string;
  sourceUrl: string | null;
  licenseNote: string | null;
  filePath: string | null;
  fileSha256: string | null;
  collectedAt: string;
  referenceDate: string | null;
  mediaType: string;
  dataStatus: DataStatus;
  isOfficial: boolean;
  metadata: Record<string, unknown>;
}

export interface PlannedPopulation {
  regionId: string;
  referenceDate: string;
  populationTotal: number;
  populationMale: number | null;
  populationFemale: number | null;
  householdCount: number | null;
  foreignPopulation: number | null;
  measurementBasis: PopulationMeasurementBasis;
  referenceDatePrecision: ReferenceDatePrecision;
  metadata: Record<string, unknown>;
  sourceKey: string;
  sourceRow: number | null;
  dataStatus: "official_observed" | "demo_sample";
}

export interface PlannedLocalTax {
  regionId: string;
  fiscalYear: number;
  taxCategory: string;
  revenueAmountWon: number;
  accountingBasis: "budget" | "settlement" | "reported";
  amountSemantics:
    | "demo_settlement"
    | "collected_amount"
    | "payment_amount"
    | "reported_total_tax_burden";
  sourceGrain:
    | "demo_sample"
    | "collection_status"
    | "statistical_yearbook_local_collection"
    | "payment_media"
    | "per_capita_burden";
  unitOriginal: "KRW" | "thousand_KRW";
  unitMultiplier: 1 | 1000;
  unitProvenance: string;
  isAggregate: boolean;
  sourceRow: number | null;
  sourceKey: string;
  dataStatus: "official_observed" | "demo_sample";
  metadata: Record<string, unknown>;
}

type PlannedTaxFact<T> = Omit<T, "sourcePath" | "sourceSha256"> & {
  sourceKey: string;
};

export type PlannedTaxCollection = PlannedTaxFact<NormalizedTaxCollection>;
export type PlannedTaxPaymentMedia =
  PlannedTaxFact<NormalizedTaxPaymentMedia>;
export type PlannedTaxAssessment = PlannedTaxFact<NormalizedTaxAssessment>;
export type PlannedTaxPerCapita = PlannedTaxFact<NormalizedTaxPerCapita>;
export type PlannedTaxpayerStatus = PlannedTaxFact<NormalizedTaxpayerStatus>;
export type PlannedTaxExemption = PlannedTaxFact<NormalizedTaxExemption>;
export type PlannedTaxUnrefunded = PlannedTaxFact<NormalizedTaxUnrefunded>;
export type PlannedTaxEnforcement = PlannedTaxFact<NormalizedTaxEnforcement>;

export interface PlannedTaxQualityIssue
  extends Omit<TaxQualityIssue, "sourcePath" | "sourceSha256"> {
  issueKey: string;
  sourceKey: string;
}

export interface PlannedPolicy {
  policyId: string;
  regionId: string | null;
  title: string;
  managingOrganization: string;
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  industries: string[];
  stages: string[];
  eligibilityText: string;
  supportText: string;
  applicationStart: string | null;
  applicationEnd: string | null;
  sourceKey: string;
  dataStatus: "official_observed" | "demo_sample";
  metadata: Record<string, unknown>;
}

export interface PlannedCouncil {
  councilRecordId: string;
  regionId: string;
  councilName: string;
  sessionName: string | null;
  meetingDate: string | null;
  agendaNumber: string | null;
  title: string;
  proposer: string | null;
  resolution: string | null;
  sourceKey: string;
  dataStatus: "official_observed" | "demo_sample";
  metadata: Record<string, unknown>;
}

export interface PlannedPressRelease {
  pressReleaseId: string;
  regionId: string;
  /** Regions merely named in the headline or body; a keyword hint, not a claim. */
  mentionedRegionIds: string[];
  issuingOrganization: string;
  department: string | null;
  contactPhone: string | null;
  author: string | null;
  title: string;
  body: string;
  bodySha256: string;
  bodyCharCount: number;
  publishedDate: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  attachmentCount: number;
  detailUrl: string;
  sourceRecordId: string;
  sourceKey: string;
  dataStatus: "official_observed";
  contentClassification:
    | "extracted_ok"
    | "mojibake_suspected"
    | "unusable_for_retrieval";
  metadata: Record<string, unknown>;
}

export interface PlannedLocator {
  sourceKey: string;
  entityType: string;
  entityKey: string;
  pageNumber: number | null;
  rowNumber: number | null;
  sectionName: string | null;
  characterStart: number | null;
  characterEnd: number | null;
  locatorText: string | null;
}

export interface RejectedFact {
  entityType: string;
  sourcePath: string;
  sourceRow: number | null;
  reason: string;
}

export interface LoadPlan {
  regions: PlannedRegion[];
  sources: PlannedSource[];
  population: PlannedPopulation[];
  localTax: PlannedLocalTax[];
  taxCollection: PlannedTaxCollection[];
  taxPaymentMedia: PlannedTaxPaymentMedia[];
  taxAssessment: PlannedTaxAssessment[];
  taxPerCapita: PlannedTaxPerCapita[];
  taxTaxpayer: PlannedTaxpayerStatus[];
  taxExemption: PlannedTaxExemption[];
  taxUnrefunded: PlannedTaxUnrefunded[];
  taxEnforcement: PlannedTaxEnforcement[];
  taxQualityIssues: PlannedTaxQualityIssue[];
  policies: PlannedPolicy[];
  council: PlannedCouncil[];
  pressReleases: PlannedPressRelease[];
  locators: PlannedLocator[];
  rejected: RejectedFact[];
  inputSha256: string;
}

const mediaTypes: Record<string, string> = {
  ".csv": "text/csv",
  ".json": "application/json",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf"
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Official sources are content-addressed. The store already refuses to keep the
 * same bytes twice, and keying on the digest means a file that is re-routed or
 * copied cannot fork into a second source and duplicate its facts.
 */
export function officialSourceKey(fileSha256: string): string {
  return `official:${fileSha256}`;
}

export function deterministicCouncilId(input: {
  sourcePath: string;
  sourceSha256: string;
  sourceRow: number;
  recordNumber: string;
  stableSourceRecordId?: string;
}): string {
  const digest = sha256(
    input.stableSourceRecordId
      ? [
          input.sourcePath.normalize("NFC"),
          "stable-source-record",
          input.stableSourceRecordId
        ].join("\u0000")
      : [
          input.sourceSha256,
          input.sourcePath.normalize("NFC"),
          input.sourceRow,
          input.recordNumber
        ].join("\u0000")
  );
  return `council-${digest.slice(0, 40)}`;
}

function populationEntityKey(row: PlannedPopulation): string {
  return `population-${sha256(
    [row.regionId, row.referenceDate, row.sourceKey].join("\u0000")
  ).slice(0, 40)}`;
}

function sourceProvider(path: string): string {
  if (path.normalize("NFC").includes("행정안전부")) return "행정안전부";
  const region = resolveGyeongbukRegion(path);
  if (!region) return "공공데이터 원천";
  if (path.normalize("NFC").includes("의회")) {
    return region.regionType === "province" ? "경상북도의회" : `${region.regionName}의회`;
  }
  return region.regionType === "province" ? "경상북도" : region.regionName;
}

function officialSourceUrl(path: string, contentKind: string): string | null {
  const normalizedPath = path.normalize("NFC");
  if (
    contentKind === "council_agenda" &&
    normalizedPath.includes("datasets/pohang-council/")
  ) {
    return "https://council.pohang.go.kr/content/activity/billSearch.html";
  }
  if (contentKind === "local_tax_yearbook") {
    return "https://www.data.go.kr/data/15086648/fileData.do";
  }
  return null;
}

function regionById(regionId: string): GyeongbukRegion | null {
  return GYEONGBUK_REGIONS.find((region) => region.regionId === regionId) ?? null;
}

function validatedRegion(regionId: string, regionName: string): GyeongbukRegion | null {
  const byId = regionById(regionId);
  const byName = resolveGyeongbukRegion(regionName);
  return byId && byName?.regionId === byId.regionId ? byId : null;
}

function integer(value: string): number | null {
  const parsed = Number(value.replace(/[,\s]/g, ""));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isAggregateCategoryForPlan(value: string): boolean {
  return ["합계", "총계", "소계", "계"].includes(
    value.normalize("NFC").replace(/\s+/gu, "")
  );
}

function uniqueBy<T>(rows: T[], key: (row: T) => string): T[] {
  return [...new Map(rows.map((row) => [key(row), row])).values()];
}

function addOfficialPopulation(
  row: OfficialPopulationRow,
  plan: Omit<LoadPlan, "inputSha256">
): void {
  const region = resolveGyeongbukRegion(row.regionName);
  const referenceDate = parseReferenceDate(row.referenceDate);
  const sourceKey = officialSourceKey(row.sourceSha256);
  if (!region || !referenceDate) {
    plan.rejected.push({
      entityType: "population_observation",
      sourcePath: row.sourcePath,
      sourceRow: row.sourceRow,
      reason: !region
        ? `Unresolved canonical Gyeongbuk region: ${row.regionName}`
        : `Invalid reference date: ${row.referenceDate}`
    });
    return;
  }
  if (!plan.sources.some((source) => source.sourceKey === sourceKey)) {
    plan.rejected.push({
      entityType: "population_observation",
      sourcePath: row.sourcePath,
      sourceRow: row.sourceRow,
      reason: "Source catalog entry is missing"
    });
    return;
  }
  const fact: PlannedPopulation = {
    regionId: region.regionId,
    referenceDate,
    populationTotal: row.populationTotal,
    populationMale: row.populationMale,
    populationFemale: row.populationFemale,
    householdCount: row.householdCount,
    foreignPopulation: row.foreignPopulation,
    measurementBasis:
      row.measurementBasis ?? "resident_registration_snapshot",
    referenceDatePrecision: row.referenceDatePrecision ?? "month",
    metadata: row.metadata ?? {},
    sourceKey,
    sourceRow: row.sourceRow,
    dataStatus: "official_observed"
  };
  plan.population.push(fact);
  plan.locators.push({
    sourceKey,
    entityType: "population_observation",
    entityKey: populationEntityKey(fact),
    pageNumber: null,
    rowNumber: row.sourceRow,
    sectionName: "sheet" in row ? row.sheet : null,
    characterStart: null,
    characterEnd: null,
    locatorText: `${row.sourcePath}#row=${row.sourceRow}`
  });
}

function addOfficialCouncil(
  row: OfficialCouncilRow,
  plan: Omit<LoadPlan, "inputSha256">
): void {
  const region = resolveGyeongbukRegion(row.regionName);
  const sourceKey = officialSourceKey(row.sourceSha256);
  const meetingDate = row.meetingDate
    ? parseReferenceDate(row.meetingDate)
    : null;
  if (!region) {
    plan.rejected.push({
      entityType: "council_record",
      sourcePath: row.sourcePath,
      sourceRow: row.sourceRow,
      reason: `Unresolved canonical Gyeongbuk region: ${row.regionName}`
    });
    return;
  }
  if (row.meetingDate && !meetingDate) {
    plan.rejected.push({
      entityType: "council_record",
      sourcePath: row.sourcePath,
      sourceRow: row.sourceRow,
      reason: `Invalid meeting date: ${row.meetingDate}`
    });
    return;
  }
  if (!plan.sources.some((source) => source.sourceKey === sourceKey)) {
    plan.rejected.push({
      entityType: "council_record",
      sourcePath: row.sourcePath,
      sourceRow: row.sourceRow,
      reason: "Source catalog entry is missing"
    });
    return;
  }
  const councilRecordId = deterministicCouncilId({
    ...row,
    stableSourceRecordId: row.sourceRecordId || undefined
  });
  plan.council.push({
    councilRecordId,
    regionId: region.regionId,
    councilName: row.councilName,
    sessionName: row.sessionName,
    meetingDate,
    agendaNumber: row.recordNumber || null,
    title: row.title,
    proposer: row.proposer || null,
    resolution: row.result,
    sourceKey,
    dataStatus: "official_observed",
    metadata: {
      sourceRow: row.sourceRow,
      sourceRecordId: row.sourceRecordId || null,
      detailUrl: row.detailUrl || null,
      dataQualityIssues: row.dataQualityIssues
    }
  });
  plan.locators.push({
    sourceKey,
    entityType: "council_record",
    entityKey: councilRecordId,
    pageNumber: null,
    rowNumber: row.sourceRow,
    sectionName: row.sessionName,
    characterStart: null,
    characterEnd: null,
    locatorText: `${row.sourcePath}#row=${row.sourceRow}`
  });
}

/**
 * Press release identity comes from the board's own post id, so re-crawling the
 * same announcement into a new snapshot file updates one row instead of
 * creating a second copy under a different source key.
 */
export function pressReleaseId(sourceRecordId: string): string {
  return `gb-press-${sourceRecordId}`;
}

/**
 * A handful of posts contain an entire HWP-exported HTML document pasted as
 * escaped source. Recovery runs first, so anything still reading as markup here
 * could not be salvaged and is genuinely unusable — a different failure from
 * garbled encoding, and one that deserves an accurate label.
 */
function looksLikeMarkupSource(body: string): boolean {
  return containsMarkupSource(body);
}

function classifyPressBody(
  title: string,
  body: string
): PlannedPressRelease["contentClassification"] {
  const text = `${title}\n${body}`;
  if (body.trim().length === 0) return "unusable_for_retrieval";
  if (looksLikeMarkupSource(body)) return "unusable_for_retrieval";
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  if (replacement > 0 && replacement / text.length > 0.005) {
    return "mojibake_suspected";
  }
  const hangul = (text.match(/[\uAC00-\uD7A3]/g) ?? []).length;
  if (hangul / text.length < 0.1) return "mojibake_suspected";
  return "extracted_ok";
}

function mentionedRegionIds(title: string, body: string): string[] {
  const haystack = `${title}\n${body}`.normalize("NFC");
  const found = new Set<string>();
  for (const region of GYEONGBUK_REGIONS) {
    if (region.regionType === "province") continue;
    if (haystack.includes(region.regionName)) found.add(region.regionId);
  }
  return [...found].sort();
}

function addOfficialPressRelease(
  row: OfficialPressReleaseRow,
  plan: Omit<LoadPlan, "inputSha256">
): void {
  const sourceKey = officialSourceKey(row.sourceSha256);
  const publishedDate = row.publishedDate
    ? parseReferenceDate(row.publishedDate)
    : null;
  if (!plan.sources.some((source) => source.sourceKey === sourceKey)) {
    plan.rejected.push({
      entityType: "press_release",
      sourcePath: row.sourcePath,
      sourceRow: row.sourceRow,
      reason: "Source catalog entry is missing"
    });
    return;
  }
  if (row.publishedDate && !publishedDate) {
    plan.rejected.push({
      entityType: "press_release",
      sourcePath: row.sourcePath,
      sourceRow: row.sourceRow,
      reason: `Invalid published date: ${row.publishedDate}`
    });
    return;
  }
  const region = resolveGyeongbukRegion(row.provinceName);
  if (!region) {
    plan.rejected.push({
      entityType: "press_release",
      sourcePath: row.sourcePath,
      sourceRow: row.sourceRow,
      reason: `Unresolved canonical Gyeongbuk region: ${row.provinceName}`
    });
    return;
  }
  const id = pressReleaseId(row.sourceRecordId);
  plan.pressReleases.push({
    pressReleaseId: id,
    regionId: region.regionId,
    mentionedRegionIds: mentionedRegionIds(row.title, row.body),
    issuingOrganization: row.provinceName,
    department: row.department,
    contactPhone: row.contactPhone,
    author: row.author,
    title: row.title,
    body: row.body,
    bodySha256: row.bodySha256 || sha256(row.body),
    bodyCharCount: row.body.length,
    publishedDate,
    publishedAt: row.publishedAt,
    viewCount: row.viewCount,
    attachmentCount: row.attachmentNames.length,
    detailUrl: row.detailUrl,
    sourceRecordId: row.sourceRecordId,
    sourceKey,
    dataStatus: "official_observed",
    contentClassification: classifyPressBody(row.title, row.body),
    metadata: {
      sourceRow: row.sourceRow,
      subheadings: row.subheadings,
      attachmentNames: row.attachmentNames,
      recordType: "press_release",
      evidenceRole: "narrative_context_only"
    }
  });
  plan.locators.push({
    sourceKey,
    entityType: "press_release",
    entityKey: id,
    pageNumber: null,
    rowNumber: row.sourceRow,
    sectionName: row.department,
    characterStart: null,
    characterEnd: null,
    locatorText: `${row.sourcePath}#row=${row.sourceRow}`
  });
}

function taxEntityKey(
  entityType: string,
  sourceKey: string,
  sourceRow: number,
  suffix = ""
): string {
  return `${entityType}-${sha256(
    [sourceKey, sourceRow, suffix].join("\u0000")
  ).slice(0, 40)}`;
}

function addTaxLocator(
  plan: Omit<LoadPlan, "inputSha256">,
  input: {
    sourceKey: string;
    sourcePath: string;
    sourceRow: number;
    entityType: string;
    suffix?: string;
    sectionName?: string | null;
  }
): void {
  plan.locators.push({
    sourceKey: input.sourceKey,
    entityType: input.entityType,
    entityKey: taxEntityKey(
      input.entityType,
      input.sourceKey,
      input.sourceRow,
      input.suffix
    ),
    pageNumber: null,
    rowNumber: input.sourceRow,
    sectionName: input.sectionName ?? null,
    characterStart: null,
    characterEnd: null,
    locatorText: `${input.sourcePath}#row=${input.sourceRow}`
  });
}

function taxSourceKey(
  plan: Omit<LoadPlan, "inputSha256">,
  sourcePath: string,
  sourceSha256: string
): string | null {
  const sourceKey = officialSourceKey(sourceSha256);
  return plan.sources.some((source) => source.sourceKey === sourceKey)
    ? sourceKey
    : null;
}

function addOfficialTaxData(
  etl: EtlResult,
  plan: Omit<LoadPlan, "inputSha256">
): void {
  if (!etl.localTax) return;
  const addRows = <
    T extends { sourcePath: string; sourceSha256: string; sourceRow: number }
  >(
    rows: T[],
    target: Array<Omit<T, "sourcePath" | "sourceSha256"> & { sourceKey: string }>,
    entityType: string,
    section: (row: T) => string | null
  ): void => {
    for (const row of rows) {
      const sourceKey = taxSourceKey(plan, row.sourcePath, row.sourceSha256);
      if (!sourceKey) {
        plan.rejected.push({
          entityType,
          sourcePath: row.sourcePath,
          sourceRow: row.sourceRow,
          reason: "Source catalog entry is missing"
        });
        continue;
      }
      const {
        sourcePath,
        sourceSha256: _sourceSha256,
        ...fact
      } = row;
      target.push({ ...fact, sourceKey });
      addTaxLocator(plan, {
        sourceKey,
        sourcePath,
        sourceRow: row.sourceRow,
        entityType,
        suffix: section(row) ?? "",
        sectionName: section(row)
      });
    }
  };

  addRows(
    etl.localTax.collection,
    plan.taxCollection,
    "local_tax_collection_status",
    (row) => `${row.fiscalYear}:${row.taxCategory}`
  );
  addRows(
    etl.localTax.paymentMedia,
    plan.taxPaymentMedia,
    "local_tax_payment_media",
    (row) =>
      `${row.fiscalYear}:${row.taxCategory}:${row.paymentMethod ?? "none"}`
  );
  addRows(
    etl.localTax.assessment,
    plan.taxAssessment,
    "local_tax_assessment_status",
    (row) => `${row.fiscalYear}:${row.taxCategory}`
  );
  addRows(
    etl.localTax.perCapita,
    plan.taxPerCapita,
    "local_tax_per_capita_burden",
    (row) => String(row.fiscalYear)
  );
  addRows(
    etl.localTax.taxpayer,
    plan.taxTaxpayer,
    "local_tax_taxpayer_status",
    (row) =>
      `${row.fiscalYear}:${row.taxCategory}:${row.taxpayerType}:${row.jurisdictionScope}`
  );
  addRows(
    etl.localTax.exemption,
    plan.taxExemption,
    "local_tax_exemption_status",
    (row) => `${row.fiscalYear}:${row.taxCategory}`
  );
  addRows(
    etl.localTax.unrefunded,
    plan.taxUnrefunded,
    "local_tax_unrefunded_status",
    (row) =>
      `${row.fiscalYear}:${row.taxCategory}:${row.unrefundedType}:${row.taxpayerType}`
  );
  addRows(
    etl.localTax.enforcement,
    plan.taxEnforcement,
    "local_tax_enforcement_statistic",
    (row) => `${row.enforcementDate}:${row.agency}`
  );

  for (const row of etl.localTax.headlineRevenue) {
    const sourceKey = taxSourceKey(plan, row.sourcePath, row.sourceSha256);
    if (!sourceKey) {
      plan.rejected.push({
        entityType: "local_tax_revenue",
        sourcePath: row.sourcePath,
        sourceRow: row.sourceRow,
        reason: "Source catalog entry is missing"
      });
      continue;
    }
    plan.localTax.push({
      regionId: row.regionId,
      fiscalYear: row.fiscalYear,
      taxCategory: row.taxCategory,
      revenueAmountWon: row.revenueAmountWon,
      accountingBasis: row.accountingBasis,
      amountSemantics: row.amountSemantics,
      sourceGrain: row.sourceGrain,
      unitOriginal: row.unitOriginal,
      unitMultiplier: row.unitMultiplier,
      unitProvenance: row.unitProvenance,
      isAggregate: row.isAggregate,
      sourceRow: row.sourceRow,
      sourceKey,
      dataStatus: "official_observed",
      metadata: row.metadata
    });
    addTaxLocator(plan, {
      sourceKey,
      sourcePath: row.sourcePath,
      sourceRow: row.sourceRow,
      entityType: "local_tax_revenue",
      suffix: `${row.fiscalYear}:${row.taxCategory}:${row.accountingBasis}`,
      sectionName: `${row.sourceGrain}:${row.amountSemantics}`
    });
  }

  for (const qualityIssue of etl.localTax.qualityIssues) {
    const sourceKey = taxSourceKey(
      plan,
      qualityIssue.sourcePath,
      qualityIssue.sourceSha256
    );
    if (!sourceKey) continue;
    const {
      sourcePath: _sourcePath,
      sourceSha256: _sourceSha256,
      ...issueValue
    } = qualityIssue;
    plan.taxQualityIssues.push({
      ...issueValue,
      issueKey: taxQualityIssueKey(qualityIssue),
      sourceKey
    });
  }
}

export async function createLoadPlan(etl: EtlResult): Promise<LoadPlan> {
  const plan: Omit<LoadPlan, "inputSha256"> = {
    regions: GYEONGBUK_REGIONS.map((region) => ({
      regionId: region.regionId,
      regionName: region.regionName,
      regionType: region.regionType,
      parentRegionId: region.parentRegionId,
      normalizedName: region.regionName.replace(/\s+/g, "")
    })),
    sources: etl.catalog.map((entry) => ({
      sourceKey: officialSourceKey(entry.sha256),
      title: entry.fileNameNfc,
      provider: sourceProvider(entry.path),
      sourceUrl: officialSourceUrl(entry.path, entry.contentKind),
      licenseNote:
        entry.contentKind === "local_tax_yearbook"
          ? "공공데이터포털 이용허락범위 제한 없음"
          : null,
      filePath: entry.path,
      fileSha256: entry.sha256,
      collectedAt: entry.collectedAt,
      referenceDate: entry.referenceDate,
      mediaType: entry.mediaType,
      dataStatus: entry.dataStatus,
      isOfficial: true,
      metadata: {
        byteSize: entry.byteSize,
        contentKind: entry.contentKind,
        encoding: entry.encoding,
        parseStatus: entry.parseStatus,
        error: entry.error,
        governance:
          entry.contentKind === "property_valuation_microdata"
            ? {
                decision: "catalog_only_row_access_denied",
                reason:
                  "Address-level property microdata is excluded from analytics, search, embeddings, and general tool responses"
              }
            : entry.contentKind === "local_tax_enforcement"
              ? {
                  decision: "location_text_omitted",
                  reason:
                    "Only enforcement counts and amounts are normalized"
                }
              : undefined
      }
    })),
    population: [],
    localTax: [],
    taxCollection: [],
    taxPaymentMedia: [],
    taxAssessment: [],
    taxPerCapita: [],
    taxTaxpayer: [],
    taxExemption: [],
    taxUnrefunded: [],
    taxEnforcement: [],
    taxQualityIssues: [],
    policies: [],
    council: [],
    pressReleases: [],
    locators: [],
    rejected: etl.errors.map((error) => ({
      entityType: "catalog",
      sourcePath: error.path,
      sourceRow: null,
      reason: error.error
    }))
  };

  for (const row of etl.population) addOfficialPopulation(row, plan);
  for (const row of etl.council) addOfficialCouncil(row, plan);
  for (const row of etl.pressRelease) addOfficialPressRelease(row, plan);
  addOfficialTaxData(etl, plan);

  plan.sources = uniqueBy(plan.sources, (row) => row.sourceKey);
  plan.population = uniqueBy(
    plan.population,
    (row) => `${row.regionId}:${row.referenceDate}:${row.sourceKey}`
  );
  plan.localTax = uniqueBy(
    plan.localTax,
    (row) =>
      `${row.regionId}:${row.fiscalYear}:${row.taxCategory}:${row.accountingBasis}:${row.sourceKey}`
  );
  plan.taxCollection = uniqueBy(
    plan.taxCollection,
    (row) => `${row.sourceKey}:${row.sourceRow}`
  );
  plan.taxPaymentMedia = uniqueBy(
    plan.taxPaymentMedia,
    (row) => `${row.sourceKey}:${row.sourceRow}`
  );
  plan.taxAssessment = uniqueBy(
    plan.taxAssessment,
    (row) => `${row.sourceKey}:${row.sourceRow}`
  );
  plan.taxPerCapita = uniqueBy(
    plan.taxPerCapita,
    (row) => `${row.sourceKey}:${row.sourceRow}`
  );
  plan.taxTaxpayer = uniqueBy(
    plan.taxTaxpayer,
    (row) => `${row.sourceKey}:${row.sourceRow}`
  );
  plan.taxExemption = uniqueBy(
    plan.taxExemption,
    (row) => `${row.sourceKey}:${row.sourceRow}`
  );
  plan.taxUnrefunded = uniqueBy(
    plan.taxUnrefunded,
    (row) => `${row.sourceKey}:${row.sourceRow}`
  );
  plan.taxEnforcement = uniqueBy(
    plan.taxEnforcement,
    (row) => `${row.sourceKey}:${row.sourceRow}`
  );
  plan.taxQualityIssues = uniqueBy(
    plan.taxQualityIssues,
    (row) => row.issueKey
  );
  plan.policies = uniqueBy(plan.policies, (row) => row.policyId);
  plan.council = uniqueBy(plan.council, (row) => row.councilRecordId);
  plan.pressReleases = uniqueBy(plan.pressReleases, (row) => row.pressReleaseId);
  plan.locators = uniqueBy(
    plan.locators,
    (row) => `${row.sourceKey}:${row.entityType}:${row.entityKey}`
  );

  return {
    ...plan,
    inputSha256: sha256(
      JSON.stringify({
        sources: plan.sources.map((row) => row.sourceKey),
        population: plan.population,
        localTax: plan.localTax,
        taxCollection: plan.taxCollection,
        taxPaymentMedia: plan.taxPaymentMedia,
        taxAssessment: plan.taxAssessment,
        taxPerCapita: plan.taxPerCapita,
        taxTaxpayer: plan.taxTaxpayer,
        taxExemption: plan.taxExemption,
        taxUnrefunded: plan.taxUnrefunded,
        taxEnforcement: plan.taxEnforcement,
        taxQualityIssues: plan.taxQualityIssues,
        policies: plan.policies,
        council: plan.council,
        pressReleases: plan.pressReleases
      })
    )
  };
}
