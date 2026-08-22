import { strFromU8, unzipSync } from "fflate";
import {
  emptyLocalTaxNormalization,
  type LocalTaxNormalizationResult,
  type NormalizedHeadlineTaxRevenue,
  type TaxQualityIssue,
  type TaxReconciliation
} from "./local-tax.js";
import {
  GYEONGBUK_REGIONS,
  resolveGyeongbukRegion,
  type GyeongbukRegion
} from "./regions.js";

export interface LocalTaxYearbookInput {
  path: string;
  sha256: string;
  buffer: Uint8Array;
}

interface YearbookArchive {
  fiscalYear: number;
  sectionName: string;
  tables: string[][][];
}

const municipalityRegions = GYEONGBUK_REGIONS.filter(
  (region) => region.regionType !== "province"
);

const cityCategories = [
  "지방소비세",
  "지역자원시설세",
  "주민세",
  "지방소득세",
  "재산세",
  "자동차세",
  "담배소비세",
  "도축세",
  "도시계획세",
  "과년도수입"
] as const;

const countyFirstCategories = [
  "지방소비세",
  "주민세",
  "지방소득세",
  "재산세"
] as const;

const countySecondCategories = [
  "자동차세",
  "담배소비세",
  "도축세",
  "도시계획세",
  "과년도수입"
] as const;

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&#([0-9]+);/gu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10))
    )
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function textNodes(xml: string): string {
  return decodeXmlText(
    [...xml.matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>/gu)]
      .map((match) => match[1] ?? "")
      .join(" ")
      .replace(/<[^>]+>/gu, "")
  );
}

function tableRows(xml: string): string[][] {
  return [...xml.matchAll(/<hp:tr(?:\s[^>]*)?>([\s\S]*?)<\/hp:tr>/gu)].map(
    (rowMatch) =>
      [
        ...(rowMatch[1] ?? "").matchAll(
          /<hp:tc(?:\s[^>]*)?>([\s\S]*?)<\/hp:tc>/gu
        )
      ].map((cellMatch) => textNodes(cellMatch[1] ?? ""))
  );
}

function archiveSections(buffer: Uint8Array): Record<string, string> {
  const files = unzipSync(buffer, {
    filter: (file) =>
      file.name === "Contents/section0.xml" ||
      /^Contents\/section\d+\.xml$/u.test(file.name)
  });
  return Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, strFromU8(content)])
  );
}

function parseArchive(buffer: Uint8Array): YearbookArchive {
  const sections = archiveSections(buffer);
  const tableOfContents = textNodes(sections["Contents/section0.xml"] ?? "");
  const yearMatch = tableOfContents.match(
    /제4장\s*((?:19|20)\d{2})년도\s*시[·\s]*도,\s*시[·\s]*군[·\s]*구별\s*부과[·\s]*징수실적/u
  );
  if (!yearMatch) {
    throw new Error("Local-tax yearbook chapter/year marker was not found");
  }
  const fiscalYear = Number(yearMatch[1]);
  if (fiscalYear < 2000 || fiscalYear > new Date().getUTCFullYear() + 1) {
    throw new Error(`Local-tax yearbook fiscal year is out of range: ${fiscalYear}`);
  }

  for (const [sectionName, xml] of Object.entries(sections)) {
    const sectionText = textNodes(xml);
    if (
      !sectionText.includes("1-16. 경상북도") ||
      !sectionText.replace(/\s+/gu, "").includes("포항시")
    ) {
      continue;
    }
    const tables = [...xml.matchAll(/<hp:tbl(?:\s[^>]*)?>([\s\S]*?)<\/hp:tbl>/gu)]
      .map((match) => tableRows(match[0]))
      .filter((rows) => rows.length > 0);
    if (tables.length > 0) return { fiscalYear, sectionName, tables };
  }
  throw new Error("Gyeongbuk collection tables were not found in the yearbook");
}

export function detectLocalTaxYearbookHwpx(buffer: Uint8Array): boolean {
  try {
    const archive = parseArchive(buffer);
    return archive.tables.some((table) =>
      table.some((row) => row.join(" ").includes("1-16. 경상북도"))
    );
  } catch {
    return false;
  }
}

export function localTaxYearbookFiscalYear(
  buffer: Uint8Array
): number | null {
  try {
    return parseArchive(buffer).fiscalYear;
  } catch {
    return null;
  }
}

function numericCell(value: string): number | null {
  const normalized = value.replace(/[,\s]/gu, "");
  if (!normalized || normalized === "-" || normalized === "－") return null;
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`Unexpected local-tax yearbook amount: ${value}`);
  }
  const result = Number(normalized);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Unsafe local-tax yearbook amount: ${value}`);
  }
  return result;
}

function amountWon(value: string): number | null {
  const amount = numericCell(value);
  if (amount === null) return null;
  const converted = amount * 1000;
  if (!Number.isSafeInteger(converted)) {
    throw new Error(`Unsafe KRW conversion for local-tax yearbook amount: ${value}`);
  }
  return converted;
}

function regionFromBaseRow(row: string[]): GyeongbukRegion | null {
  const KoreanName = row[0]?.match(/[가-힣\s]+(?:시|군)/u)?.[0];
  return KoreanName
    ? resolveGyeongbukRegion(KoreanName.replace(/\s+/gu, ""))
    : null;
}

function tableContaining(
  tables: string[][][],
  marker: string,
  startIndex = 0
): string[][] {
  const table = tables.slice(startIndex).find((candidate) =>
    candidate.some((row) => row.join(" ").includes(marker))
  );
  if (!table) throw new Error(`Required local-tax yearbook table is missing: ${marker}`);
  return table;
}

function issue(
  input: LocalTaxYearbookInput,
  values: Omit<TaxQualityIssue, "sourcePath" | "sourceSha256">
): TaxQualityIssue {
  return {
    ...values,
    sourcePath: input.path,
    sourceSha256: input.sha256
  };
}

function headlineRow(
  input: LocalTaxYearbookInput,
  archive: YearbookArchive,
  region: GyeongbukRegion,
  sourceRow: number,
  taxCategory: string,
  revenueAmountWon: number,
  isAggregate: boolean,
  metadata: Record<string, unknown>
): NormalizedHeadlineTaxRevenue {
  return {
    regionId: region.regionId,
    regionName: region.regionName,
    fiscalYear: archive.fiscalYear,
    taxCategory,
    revenueAmountWon,
    accountingBasis: "settlement",
    amountSemantics: "collected_amount",
    sourceGrain: "statistical_yearbook_local_collection",
    unitOriginal: "thousand_KRW",
    unitMultiplier: 1000,
    unitProvenance: "explicit_header_thousand_krw",
    isAggregate,
    sourcePath: input.path,
    sourceSha256: input.sha256,
    sourceRow,
    metadata: {
      ...metadata,
      sourceDocumentSection: "제2편 제4장 1-16 경상북도",
      sourceArchiveSection: archive.sectionName,
      collectionScope: "city_or_county_tax_excluding_province_tax",
      unitLabel: "단위: 천원"
    }
  };
}

export function normalizeLocalTaxYearbook(
  input: LocalTaxYearbookInput
): LocalTaxNormalizationResult {
  const result = emptyLocalTaxNormalization();
  const archive = parseArchive(input.buffer);
  const base = tableContaining(archive.tables, "1-16. 경상북도");
  const baseIndex = archive.tables.indexOf(base);
  const city = tableContaining(archive.tables, "City Tax", baseIndex + 1);
  const cityIndex = archive.tables.indexOf(city);
  const countyFirst = tableContaining(archive.tables, "군 세", cityIndex + 1);
  const countyFirstIndex = archive.tables.indexOf(countyFirst);
  const countySecond = tableContaining(
    archive.tables,
    "County Tax",
    countyFirstIndex + 1
  );
  const resolved = new Set<string>();

  for (let rowIndex = 0; rowIndex < base.length; rowIndex += 1) {
    const baseRow = base[rowIndex] ?? [];
    const region = regionFromBaseRow(baseRow);
    if (!region) continue;
    resolved.add(region.regionId);
    const combinedTotal = amountWon(baseRow[1] ?? "");
    const provinceTax = amountWon(baseRow[2] ?? "");
    if (combinedTotal === null || provinceTax === null) {
      throw new Error(`Missing total/province amount for ${region.regionName}`);
    }

    const isCity = region.regionType === "city";
    const firstRow = (isCity ? city : countyFirst)[rowIndex];
    if (!firstRow) {
      throw new Error(`Missing local-tax continuation row for ${region.regionName}`);
    }
    if (!isCity) {
      const continuationRegion = resolveGyeongbukRegion(firstRow[0] ?? "");
      if (continuationRegion?.regionId !== region.regionId) {
        throw new Error(
          `County-tax continuation order mismatch for ${region.regionName}`
        );
      }
    }
    const firstAmountOffset = isCity ? 0 : 1;
    const localAggregate = amountWon(firstRow[firstAmountOffset] ?? "");
    if (localAggregate === null) {
      throw new Error(`Missing local-tax subtotal for ${region.regionName}`);
    }
    const detailRows: Array<{ category: string; amount: number }> = [];
    const firstCategories = isCity ? cityCategories : countyFirstCategories;
    for (let index = 0; index < firstCategories.length; index += 1) {
      const amount = amountWon(firstRow[index + firstAmountOffset + 1] ?? "");
      if (amount !== null) {
        detailRows.push({ category: firstCategories[index]!, amount });
      }
    }
    if (!isCity) {
      const secondRow = countySecond[rowIndex];
      if (!secondRow) {
        throw new Error(`Missing county-tax continuation row for ${region.regionName}`);
      }
      for (let index = 0; index < countySecondCategories.length; index += 1) {
        const amount = amountWon(secondRow[index] ?? "");
        if (amount !== null) {
          detailRows.push({ category: countySecondCategories[index]!, amount });
        }
      }
    }

    const detailSum = detailRows.reduce((sum, row) => sum + row.amount, 0);
    const combinedReconciles = combinedTotal - provinceTax === localAggregate;
    const detailReconciles = detailSum === localAggregate;
    const sourceRow = rowIndex + 1;
    const reconciliationDetails = {
      combinedCollectionAmountWon: combinedTotal,
      provinceTaxAmountWon: provinceTax,
      localTaxAmountWon: localAggregate,
      detailSumWon: detailSum
    };
    result.reconciliations.push(
      {
        reconciliationCode: "yearbook_combined_minus_province_equals_local",
        sourcePath: input.path,
        regionId: region.regionId,
        fiscalYear: archive.fiscalYear,
        status: combinedReconciles ? "passed" : "warning",
        details: reconciliationDetails
      },
      {
        reconciliationCode: "yearbook_local_aggregate_vs_detail",
        sourcePath: input.path,
        regionId: region.regionId,
        fiscalYear: archive.fiscalYear,
        status: detailReconciles ? "passed" : "warning",
        details: reconciliationDetails
      }
    );
    if (!combinedReconciles || !detailReconciles) {
      result.qualityIssues.push(
        issue(input, {
          severity: "error",
          issueCode: "yearbook_local_tax_reconciliation_failed",
          entityType: "local_tax_revenue",
          sourceRow,
          fieldName: "합계",
          message:
            "Yearbook combined, province, local subtotal, and detail amounts do not reconcile",
          observed: reconciliationDetails,
          expected:
            "combined - province = local subtotal = sum(local tax details)",
          quarantined: true
        })
      );
      result.quarantinedRows += 1 + detailRows.length;
      continue;
    }

    result.headlineRevenue.push(
      headlineRow(
        input,
        archive,
        region,
        sourceRow,
        "합계",
        localAggregate,
        true,
        reconciliationDetails
      ),
      ...detailRows.map((row) =>
        headlineRow(
          input,
          archive,
          region,
          sourceRow,
          row.category,
          row.amount,
          false,
          reconciliationDetails
        )
      )
    );
  }

  const missing = municipalityRegions.filter(
    (region) => !resolved.has(region.regionId)
  );
  if (missing.length > 0 || resolved.size !== municipalityRegions.length) {
    throw new Error(
      `Yearbook Gyeongbuk coverage mismatch: resolved ${resolved.size}/${municipalityRegions.length}; missing ${missing.map((region) => region.regionName).join(", ")}`
    );
  }
  result.qualityIssues.push(
    issue(input, {
      severity: "info",
      issueCode: "yearbook_full_gyeongbuk_coverage",
      entityType: "local_tax_revenue",
      sourceRow: null,
      fieldName: null,
      message:
        "The official yearbook resolved every canonical Gyeongbuk city/county and all amount reconciliations passed",
      observed: {
        fiscalYear: archive.fiscalYear,
        regions: resolved.size,
        headlineRows: result.headlineRevenue.length
      },
      expected: {
        regions: municipalityRegions.length,
        sourceUnit: "thousand_KRW"
      },
      quarantined: false
    })
  );
  return result;
}

export function mergeLocalTaxNormalizations(
  results: LocalTaxNormalizationResult[]
): LocalTaxNormalizationResult {
  const merged = emptyLocalTaxNormalization();
  for (const result of results) {
    merged.collection.push(...result.collection);
    merged.paymentMedia.push(...result.paymentMedia);
    merged.assessment.push(...result.assessment);
    merged.perCapita.push(...result.perCapita);
    merged.taxpayer.push(...result.taxpayer);
    merged.exemption.push(...result.exemption);
    merged.unrefunded.push(...result.unrefunded);
    merged.enforcement.push(...result.enforcement);
    merged.headlineRevenue.push(...result.headlineRevenue);
    merged.qualityIssues.push(...result.qualityIssues);
    merged.reconciliations.push(...result.reconciliations);
    merged.excludedPropertyRows += result.excludedPropertyRows;
    merged.quarantinedRows += result.quarantinedRows;
  }

  const aggregateRows = merged.headlineRevenue.filter(
    (row) =>
      row.taxCategory === "합계" &&
      row.isAggregate &&
      row.amountSemantics === "collected_amount"
  );
  const yearbookRows = aggregateRows.filter(
    (row) => row.sourceGrain === "statistical_yearbook_local_collection"
  );
  for (const yearbook of yearbookRows) {
    const corroborating = aggregateRows.filter(
      (row) =>
        row.regionId === yearbook.regionId &&
        row.fiscalYear === yearbook.fiscalYear &&
        row.sourceGrain === "collection_status"
    );
    for (const row of corroborating) {
      const matches = row.revenueAmountWon === yearbook.revenueAmountWon;
      const combinedCollectionAmountWon =
        typeof yearbook.metadata.combinedCollectionAmountWon === "number"
          ? yearbook.metadata.combinedCollectionAmountWon
          : null;
      const isCombinedScope =
        combinedCollectionAmountWon !== null &&
        row.revenueAmountWon === combinedCollectionAmountWon;
      const reconciles = matches || isCombinedScope;
      merged.reconciliations.push({
        reconciliationCode: "yearbook_vs_municipal_collection",
        sourcePath: yearbook.sourcePath,
        regionId: yearbook.regionId,
        fiscalYear: yearbook.fiscalYear,
        status: reconciles ? "passed" : "warning",
        details: {
          yearbookAmountWon: yearbook.revenueAmountWon,
          municipalCollectionAmountWon: row.revenueAmountWon,
          municipalSourcePath: row.sourcePath,
          relationship: matches
            ? "same_local_tax_scope"
            : isCombinedScope
              ? "municipal_source_is_combined_province_and_local_scope"
              : "unresolved_difference"
        }
      });
      if (isCombinedScope && !matches) {
        row.metadata = {
          ...row.metadata,
          headlineEligible: false,
          collectionScope: "combined_province_and_local_tax",
          comparableHeadlineReplacement: {
            sourcePath: yearbook.sourcePath,
            amountWon: yearbook.revenueAmountWon,
            collectionScope: "city_or_county_tax_excluding_province_tax"
          }
        };
        merged.qualityIssues.push({
          severity: "info",
          issueCode: "combined_scope_aggregate_excluded_from_headline",
          entityType: "local_tax_revenue",
          sourcePath: row.sourcePath,
          sourceSha256: row.sourceSha256,
          sourceRow: row.sourceRow,
          fieldName: "합계",
          message:
            "A municipality source aggregate includes province and local taxes, so the local-tax yearbook subtotal is used for the comparable headline",
          observed: row.revenueAmountWon,
          expected: yearbook.revenueAmountWon,
          quarantined: false
        });
      } else if (!matches) {
        merged.qualityIssues.push({
          severity: "error",
          issueCode: "yearbook_vs_municipal_collection_mismatch",
          entityType: "local_tax_revenue",
          sourcePath: yearbook.sourcePath,
          sourceSha256: yearbook.sourceSha256,
          sourceRow: yearbook.sourceRow,
          fieldName: "합계",
          message:
            "Official yearbook local-tax subtotal differs from the municipality collection source",
          observed: yearbook.revenueAmountWon,
          expected: row.revenueAmountWon,
          quarantined: false
        });
      }
    }
  }

  merged.headlineRevenue.sort((left, right) =>
    [
      left.regionId,
      left.fiscalYear,
      left.taxCategory,
      left.sourceGrain,
      left.sourcePath
    ]
      .join(":")
      .localeCompare(
        [
          right.regionId,
          right.fiscalYear,
          right.taxCategory,
          right.sourceGrain,
          right.sourcePath
        ].join(":")
      )
  );
  merged.qualityIssues.sort((left, right) =>
    [
      left.severity,
      left.sourcePath,
      left.sourceRow ?? 0,
      left.issueCode
    ]
      .join(":")
      .localeCompare(
        [
          right.severity,
          right.sourcePath,
          right.sourceRow ?? 0,
          right.issueCode
        ].join(":")
      )
  );
  merged.reconciliations.sort((left, right) =>
    [left.sourcePath, left.regionId, left.fiscalYear, left.reconciliationCode]
      .join(":")
      .localeCompare(
        [
          right.sourcePath,
          right.regionId,
          right.fiscalYear,
          right.reconciliationCode
        ].join(":")
      )
  );
  return merged;
}
