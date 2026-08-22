import type {
  ComparableTrendAnalysis,
  ComparableTrendPoint,
  LocalTaxRecord,
  PolicyMatch,
  PolicyRecord,
  PopulationRecord,
  TrendPoint,
  TrendSummary
} from "./types.js";

export function normalizeRegionName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/^경상북도\s*/, "")
    .replace(/\s+/g, "")
    .trim();
}

export function summarizeTrend(points: TrendPoint[]): TrendSummary {
  if (points.length < 2) {
    throw new Error("추세를 계산하려면 비교 가능한 데이터가 두 건 이상 필요합니다.");
  }
  const sorted = [...points].sort((a, b) => a.year - b.year);
  const start = sorted[0];
  const end = sorted.at(-1);
  if (!start || !end) {
    throw new Error("추세 시작·종료 값을 찾을 수 없습니다.");
  }
  const absoluteChange = end.value - start.value;
  const changePercent =
    start.value === 0
      ? null
      : Number(((absoluteChange / start.value) * 100).toFixed(2));
  return {
    startValue: start.value,
    endValue: end.value,
    absoluteChange,
    changePercent,
    changePercentUnavailableReason:
      start.value === 0 ? "zero_baseline" : null,
    direction:
      absoluteChange > 0 ? "increase" : absoluteChange < 0 ? "decrease" : "flat"
  };
}

function compatibilityKey(point: ComparableTrendPoint): string {
  const value = point.compatibility;
  return JSON.stringify([
    value.dataStatus,
    value.populationMeasurementBasis,
    value.referenceDatePrecision,
    value.accountingBasis,
    value.amountSemantics,
    value.sourceGrain,
    value.unitOriginal,
    value.unitMultiplier
  ]);
}

export function analyzeComparableTrend(
  points: ComparableTrendPoint[]
): ComparableTrendAnalysis {
  const sorted = [...points].sort((left, right) => left.year - right.year);
  const segments: ComparableTrendAnalysis["segments"] = [];
  for (const point of sorted) {
    const previous = segments.at(-1);
    const previousKey = previous
      ? JSON.stringify([
          previous.compatibility.dataStatus,
          previous.compatibility.populationMeasurementBasis,
          previous.compatibility.referenceDatePrecision,
          previous.compatibility.accountingBasis,
          previous.compatibility.amountSemantics,
          previous.compatibility.sourceGrain,
          previous.compatibility.unitOriginal,
          previous.compatibility.unitMultiplier
        ])
      : null;
    if (!previous || previousKey !== compatibilityKey(point)) {
      segments.push({
        compatibility: point.compatibility,
        points: [
          { year: point.year, value: point.value, sourceId: point.sourceId }
        ],
        summary: null,
        summaryUnavailableReason: "insufficient_points"
      });
      continue;
    }
    previous.points.push({
      year: point.year,
      value: point.value,
      sourceId: point.sourceId
    });
  }
  for (const segment of segments) {
    if (segment.points.length >= 2) {
      segment.summary = summarizeTrend(segment.points);
      segment.summaryUnavailableReason = null;
    }
  }
  if (sorted.length < 2) {
    return {
      summary: null,
      summaryUnavailableReason: "insufficient_points",
      segments
    };
  }
  if (new Set(sorted.map(compatibilityKey)).size !== 1) {
    return {
      summary: null,
      summaryUnavailableReason: "incomparable_sources",
      segments
    };
  }
  return {
    summary: summarizeTrend(sorted),
    summaryUnavailableReason: null,
    segments
  };
}

export function populationTrendPoints(
  records: PopulationRecord[]
): ComparableTrendPoint[] {
  return records.map((record) => ({
    year: record.year,
    value: record.populationTotal,
    sourceId: record.sourceId,
    compatibility: {
      dataStatus: record.dataStatus,
      populationMeasurementBasis: record.measurementBasis,
      referenceDatePrecision: record.referenceDatePrecision,
      accountingBasis: null,
      amountSemantics: null,
      sourceGrain: null,
      unitOriginal: null,
      unitMultiplier: null
    }
  }));
}

export function localTaxTrendPoints(
  records: LocalTaxRecord[]
): ComparableTrendPoint[] {
  return records.map((record) => ({
    year: record.fiscalYear,
    value: record.revenueAmountWon,
    sourceId: record.sourceId,
    compatibility: {
      dataStatus: record.dataStatus,
      populationMeasurementBasis: null,
      referenceDatePrecision: null,
      accountingBasis: record.accountingBasis,
      amountSemantics: record.amountSemantics ?? null,
      sourceGrain: record.sourceGrain ?? null,
      unitOriginal: record.unitOriginal ?? null,
      unitMultiplier: record.unitMultiplier ?? null
    }
  }));
}

export function comparePopulationAndTax(
  population: PopulationRecord[],
  taxes: LocalTaxRecord[],
  startYear: number,
  endYear: number,
  regionFilter?: string[]
) {
  const filters = regionFilter?.map(normalizeRegionName);
  const regionIds = new Set([
    ...population.map((record) => record.regionId),
    ...taxes.map((record) => record.regionId)
  ]);

  return [...regionIds]
    .map((regionId) => {
      const populationRows = population.filter(
        (record) =>
          record.regionId === regionId &&
          record.year >= startYear &&
          record.year <= endYear
      );
      const taxRows = taxes.filter(
        (record) =>
          record.regionId === regionId &&
          record.taxCategory === "합계" &&
          record.fiscalYear >= startYear &&
          record.fiscalYear <= endYear
      );
      const regionName =
        populationRows[0]?.regionName ?? taxRows[0]?.regionName ?? regionId;
      if (
        filters &&
        !filters.some((filter) => normalizeRegionName(regionName).includes(filter))
      ) {
        return null;
      }
      const hasEndpoints =
        populationRows.some((record) => record.year === startYear) &&
        populationRows.some((record) => record.year === endYear) &&
        taxRows.some((record) => record.fiscalYear === startYear) &&
        taxRows.some((record) => record.fiscalYear === endYear);
      const populationAnalysis = analyzeComparableTrend(
        populationTrendPoints(populationRows)
      );
      const taxAnalysis = analyzeComparableTrend(localTaxTrendPoints(taxRows));
      const populationStatuses = [
        ...new Set(populationRows.map((record) => record.dataStatus))
      ];
      const taxStatuses = [
        ...new Set(taxRows.map((record) => record.dataStatus))
      ];
      const populationOfficial =
        populationStatuses.length > 0 &&
        populationStatuses.every((status) => status === "official_observed");
      const taxOfficial =
        taxStatuses.length > 0 &&
        taxStatuses.every((status) => status === "official_observed");
      const notEvaluableReason = !hasEndpoints
        ? "missing_endpoints"
        : populationAnalysis.summaryUnavailableReason ??
          taxAnalysis.summaryUnavailableReason ??
          (!populationOfficial || !taxOfficial
            ? "non_official_data"
            : null);
      const evaluable = notEvaluableReason === null;
      const populationTrend = populationOfficial
        ? populationAnalysis.summary
        : null;
      const taxTrend = taxOfficial ? taxAnalysis.summary : null;
      return {
        regionId,
        regionName,
        populationTrend,
        taxTrend,
        populationSeries: populationOfficial
          ? populationAnalysis.segments
          : populationAnalysis.segments.map((segment) => ({
              ...segment,
              summary: null,
              summaryUnavailableReason: "non_official_data" as const
            })),
        taxSeries: taxOfficial
          ? taxAnalysis.segments
          : taxAnalysis.segments.map((segment) => ({
              ...segment,
              summary: null,
              summaryUnavailableReason: "non_official_data" as const
            })),
        populationDataStatuses: populationStatuses,
        populationMeasurementBases: [
          ...new Set(
            populationRows.map((record) => record.measurementBasis)
          )
        ],
        taxDataStatuses: taxStatuses,
        taxAmountSemantics: [
          ...new Set(
            taxRows
              .map((record) => record.amountSemantics)
              .filter((value): value is NonNullable<typeof value> => Boolean(value))
          )
        ],
        taxSourceGrains: [
          ...new Set(
            taxRows
              .map((record) => record.sourceGrain)
              .filter((value): value is NonNullable<typeof value> => Boolean(value))
          )
        ],
        populationSourceIds: [
          ...new Set(populationRows.map((record) => record.sourceId))
        ],
        taxSourceIds: [...new Set(taxRows.map((record) => record.sourceId))],
        evaluable,
        notEvaluableReason,
        matches:
          evaluable && populationTrend && taxTrend
            ? populationTrend.direction === "decrease" &&
              taxTrend.direction === "increase"
            : null
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => {
      if (a.matches !== b.matches) return a.matches === true ? -1 : 1;
      if (a.evaluable !== b.evaluable) return a.evaluable ? -1 : 1;
      return (b.taxTrend?.changePercent ?? 0) - (a.taxTrend?.changePercent ?? 0);
    });
}

export function evaluatePolicyEligibility(
  policy: PolicyRecord,
  input: { region: string; age: number; query: string; stage?: string }
): PolicyMatch {
  const reasons: string[] = [];
  const unmetConditions: string[] = [];
  const regionMatches =
    policy.regionName === "경상북도" ||
    normalizeRegionName(policy.regionName) === normalizeRegionName(input.region);
  if (regionMatches) reasons.push(`${policy.regionName} 지역 조건에 부합`);
  else unmetConditions.push(`대상 지역은 ${policy.regionName}`);

  const ageMatches =
    (policy.ageMin === null || input.age >= policy.ageMin) &&
    (policy.ageMax === null || input.age <= policy.ageMax);
  if (ageMatches) {
    reasons.push(
      policy.ageMin === null && policy.ageMax === null
        ? "연령 제한 없음"
        : `만 ${policy.ageMin ?? 0}~${policy.ageMax ?? "제한 없음"}세 조건에 부합`
    );
  } else {
    unmetConditions.push(
      `연령 조건: 만 ${policy.ageMin ?? 0}~${policy.ageMax ?? "제한 없음"}세`
    );
  }

  const query = input.query.normalize("NFC").toLowerCase();
  const industryMatches = policy.industries.some(
    (industry) =>
      query.includes(industry.toLowerCase()) ||
      policy.title.toLowerCase().includes(query) ||
      policy.eligibilityText.toLowerCase().includes(query)
  );
  if (industryMatches) reasons.push("관심 업종/키워드와 일치");
  else unmetConditions.push(`대상 분야: ${policy.industries.join(", ")}`);

  const stageMatches =
    !input.stage ||
    policy.stages.some((stage) => stage.includes(input.stage!) || input.stage!.includes(stage));
  if (stageMatches) reasons.push(input.stage ? "창업 단계 조건에 부합" : "창업 단계 추가 확인 필요");
  else unmetConditions.push(`대상 단계: ${policy.stages.join(", ")}`);

  const eligible = regionMatches && ageMatches && industryMatches && stageMatches;
  return {
    policy,
    eligible,
    reasons,
    unmetConditions,
    score: reasons.length * 10 - unmetConditions.length * 5
  };
}
