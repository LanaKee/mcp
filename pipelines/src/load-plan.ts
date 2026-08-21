import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseKoreanCsv } from "./csv.js";
import { parseReferenceDate } from "./dates.js";
import {
  repositoryRoot,
  type EtlResult,
  type OfficialCouncilRow,
  type OfficialPopulationRow
} from "./etl.js";
import {
  GYEONGBUK_REGIONS,
  resolveGyeongbukRegion,
  type GyeongbukRegion
} from "./regions.js";

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
  sourceKey: string;
  sourceRow: number | null;
  dataStatus: "official_observed" | "demo_sample";
}

export interface PlannedLocalTax {
  regionId: string;
  fiscalYear: number;
  taxCategory: string;
  revenueAmountWon: number;
  accountingBasis: "budget" | "settlement";
  sourceKey: string;
  dataStatus: "official_observed" | "demo_sample";
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
  policies: PlannedPolicy[];
  council: PlannedCouncil[];
  locators: PlannedLocator[];
  rejected: RejectedFact[];
  inputSha256: string;
}

interface DemoSourceDefinition {
  sourceId: string;
  title: string;
  provider: string;
  sourceUrl: string | null;
  collectedAt: string;
  dataStatus: "demo_sample";
  isOfficial: false;
  locator: string;
  note: string;
}

interface DemoPolicy {
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
  dataStatus: "demo_sample";
}

interface DemoCouncil {
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
  dataStatus: "demo_sample";
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

export function officialSourceKey(path: string, fileSha256: string): string {
  return `official:${path.normalize("NFC")}:${fileSha256}`;
}

export function demoSourceKey(logicalSourceId: string, fileSha256: string): string {
  return `demo:${logicalSourceId}:${fileSha256}`;
}

export function deterministicCouncilId(input: {
  sourcePath: string;
  sourceSha256: string;
  sourceRow: number;
  recordNumber: string;
}): string {
  const digest = sha256(
    [
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
  const region = resolveGyeongbukRegion(path);
  if (!region) return "공공데이터 원천";
  if (path.normalize("NFC").includes("의회")) {
    return region.regionType === "province" ? "경상북도의회" : `${region.regionName}의회`;
  }
  return region.regionType === "province" ? "경상북도" : region.regionName;
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

function uniqueBy<T>(rows: T[], key: (row: T) => string): T[] {
  return [...new Map(rows.map((row) => [key(row), row])).values()];
}

function addOfficialPopulation(
  row: OfficialPopulationRow,
  plan: Omit<LoadPlan, "inputSha256">
): void {
  const region = resolveGyeongbukRegion(row.regionName);
  const referenceDate = parseReferenceDate(row.referenceDate);
  const sourceKey = officialSourceKey(row.sourcePath, row.sourceSha256);
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
  const sourceKey = officialSourceKey(row.sourcePath, row.sourceSha256);
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
  const councilRecordId = deterministicCouncilId(row);
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
    metadata: { sourceRow: row.sourceRow }
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

async function addDemoData(plan: Omit<LoadPlan, "inputSha256">): Promise<void> {
  const sampleDirectory = resolve(repositoryRoot, "data/sample");
  const definitions = JSON.parse(
    await readFile(resolve(sampleDirectory, "sources.json"), "utf8")
  ) as DemoSourceDefinition[];
  const sourceKeys = new Map<string, string>();

  for (const source of definitions) {
    const absolute = resolve(repositoryRoot, source.locator);
    const fileBuffer = await readFile(absolute);
    const fileSha256 = sha256(fileBuffer);
    const sourceKey = demoSourceKey(source.sourceId, fileSha256);
    sourceKeys.set(source.sourceId, sourceKey);
    plan.sources.push({
      sourceKey,
      title: source.title,
      provider: source.provider,
      sourceUrl: source.sourceUrl,
      licenseNote: source.note,
      filePath: source.locator,
      fileSha256,
      collectedAt: source.collectedAt,
      referenceDate: null,
      mediaType: mediaTypes[extname(source.locator)] ?? "application/octet-stream",
      dataStatus: "demo_sample",
      isOfficial: false,
      metadata: { logicalSourceId: source.sourceId, note: source.note }
    });
  }

  const populationPath = "data/sample/population.csv";
  const populationRows = parseKoreanCsv(
    await readFile(resolve(repositoryRoot, populationPath))
  ).rows;
  for (let index = 0; index < populationRows.length; index += 1) {
    const row = populationRows[index]!;
    const region = validatedRegion(row.region_id ?? "", row.region_name ?? "");
    const sourceKey = sourceKeys.get(row.source_id ?? "");
    const year = integer(row.year ?? "");
    const populationTotal = integer(row.population_total ?? "");
    if (!region || !sourceKey || !year || populationTotal === null) {
      plan.rejected.push({
        entityType: "population_observation",
        sourcePath: populationPath,
        sourceRow: index + 2,
        reason: "Invalid demo population region, source, year, or total"
      });
      continue;
    }
    const fact: PlannedPopulation = {
      regionId: region.regionId,
      referenceDate: `${year}-12-31`,
      populationTotal,
      populationMale: null,
      populationFemale: null,
      householdCount: null,
      foreignPopulation: null,
      sourceKey,
      sourceRow: index + 2,
      dataStatus: "demo_sample"
    };
    plan.population.push(fact);
    plan.locators.push({
      sourceKey,
      entityType: "population_observation",
      entityKey: populationEntityKey(fact),
      pageNumber: null,
      rowNumber: index + 2,
      sectionName: null,
      characterStart: null,
      characterEnd: null,
      locatorText: `${populationPath}#row=${index + 2}`
    });
  }

  const taxPath = "data/sample/local-tax.csv";
  const taxRows = parseKoreanCsv(await readFile(resolve(repositoryRoot, taxPath))).rows;
  for (let index = 0; index < taxRows.length; index += 1) {
    const row = taxRows[index]!;
    const region = validatedRegion(row.region_id ?? "", row.region_name ?? "");
    const sourceKey = sourceKeys.get(row.source_id ?? "");
    const fiscalYear = integer(row.fiscal_year ?? "");
    const revenueAmountWon = integer(row.revenue_amount_won ?? "");
    const accountingBasis =
      row.accounting_basis === "budget" || row.accounting_basis === "settlement"
        ? row.accounting_basis
        : null;
    if (!region || !sourceKey || !fiscalYear || revenueAmountWon === null || !accountingBasis) {
      plan.rejected.push({
        entityType: "local_tax_revenue",
        sourcePath: taxPath,
        sourceRow: index + 2,
        reason: "Invalid demo local-tax region, source, year, amount, or basis"
      });
      continue;
    }
    plan.localTax.push({
      regionId: region.regionId,
      fiscalYear,
      taxCategory: row.tax_category ?? "",
      revenueAmountWon,
      accountingBasis,
      sourceKey,
      dataStatus: "demo_sample"
    });
  }

  const policyPath = "data/sample/policies.json";
  const policies = JSON.parse(
    await readFile(resolve(repositoryRoot, policyPath), "utf8")
  ) as DemoPolicy[];
  for (let index = 0; index < policies.length; index += 1) {
    const row = policies[index]!;
    const region = validatedRegion(row.regionId, row.regionName);
    const sourceKey = sourceKeys.get(row.sourceId);
    if (!region || !sourceKey) {
      plan.rejected.push({
        entityType: "policy_program",
        sourcePath: policyPath,
        sourceRow: index + 1,
        reason: "Invalid demo policy region or source"
      });
      continue;
    }
    plan.policies.push({
      policyId: row.policyId,
      regionId: region.regionId,
      title: row.title,
      managingOrganization:
        plan.sources.find((source) => source.sourceKey === sourceKey)?.provider ??
        "gyeongbuk-public-ai 프로젝트",
      targetAgeMin: row.ageMin,
      targetAgeMax: row.ageMax,
      industries: row.industries,
      stages: row.stages,
      eligibilityText: row.eligibilityText,
      supportText: row.support,
      applicationStart: null,
      applicationEnd: null,
      sourceKey,
      dataStatus: "demo_sample",
      metadata: { applicationPeriod: row.applicationPeriod }
    });
  }

  const councilPath = "data/sample/council-records.json";
  const councilRows = JSON.parse(
    await readFile(resolve(repositoryRoot, councilPath), "utf8")
  ) as DemoCouncil[];
  for (let index = 0; index < councilRows.length; index += 1) {
    const row = councilRows[index]!;
    const region = validatedRegion(row.regionId, row.regionName);
    const sourceKey = sourceKeys.get(row.sourceId);
    const meetingDate = parseReferenceDate(row.meetingDate);
    if (!region || !sourceKey || !meetingDate) {
      plan.rejected.push({
        entityType: "council_record",
        sourcePath: councilPath,
        sourceRow: index + 1,
        reason: "Invalid demo council region, source, or meeting date"
      });
      continue;
    }
    plan.council.push({
      councilRecordId: row.recordId,
      regionId: region.regionId,
      councilName: row.council,
      sessionName: row.session,
      meetingDate,
      agendaNumber: null,
      title: row.title,
      proposer: null,
      resolution: null,
      sourceKey,
      dataStatus: "demo_sample",
      metadata: { content: row.content, locator: row.locator }
    });
    plan.locators.push({
      sourceKey,
      entityType: "council_record",
      entityKey: row.recordId,
      pageNumber: null,
      rowNumber: index + 1,
      sectionName: row.session,
      characterStart: null,
      characterEnd: null,
      locatorText: row.locator
    });
  }
}

export async function createLoadPlan(
  etl: EtlResult,
  options: { includeDemo?: boolean } = {}
): Promise<LoadPlan> {
  const plan: Omit<LoadPlan, "inputSha256"> = {
    regions: GYEONGBUK_REGIONS.map((region) => ({
      regionId: region.regionId,
      regionName: region.regionName,
      regionType: region.regionType,
      parentRegionId: region.parentRegionId,
      normalizedName: region.regionName.replace(/\s+/g, "")
    })),
    sources: etl.catalog.map((entry) => ({
      sourceKey: officialSourceKey(entry.path, entry.sha256),
      title: entry.fileNameNfc,
      provider: sourceProvider(entry.path),
      sourceUrl: null,
      licenseNote: null,
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
        error: entry.error
      }
    })),
    population: [],
    localTax: [],
    policies: [],
    council: [],
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
  if (options.includeDemo !== false) await addDemoData(plan);

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
  plan.policies = uniqueBy(plan.policies, (row) => row.policyId);
  plan.council = uniqueBy(plan.council, (row) => row.councilRecordId);
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
        policies: plan.policies,
        council: plan.council
      })
    )
  };
}
