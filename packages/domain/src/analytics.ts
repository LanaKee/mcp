import type {
  ComparableTrendAnalysis,
  ComparableTrendPoint,
  LocalTaxRecord,
  PolicyMatch,
  PolicyRecord,
  PeerComparison,
  PeerRegionExclusion,
  PeerRegionSeries,
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

/**
 * Compares the same measure across peer regions, and refuses when the series
 * are not the same measurement.
 *
 * Peer comparison is the easiest way to produce a confident wrong answer from
 * this data: two counties' tax figures can differ because one is 예산 and the
 * other 결산, or because one series is 천원 and the other 원, and the resulting
 * ranking looks entirely plausible. So comparability is settled before any
 * ranking exists, and a mismatch returns a refusal rather than a caveated
 * number — a caveat under a chart is not read.
 *
 * Regions are not required to be comparable across their whole history. The
 * loaded data switches measurement basis mid-series (인구 moves from
 * tax_year_reported_population to resident_registration_snapshot in 2025), so
 * demanding one basis per region would reject almost every real comparison.
 * Instead the largest basis shared by the group is selected, and the years
 * outside it are dropped with the reason stated.
 */
export function comparePeerRegions(input: {
  metric: string;
  unit: string;
  series: Array<{ region: string; points: ComparableTrendPoint[] }>;
}): PeerComparison {
  const excluded: PeerRegionExclusion[] = [];
  const withData: Array<{ region: string; points: ComparableTrendPoint[] }> = [];
  for (const entry of input.series) {
    if (entry.points.length === 0) {
      excluded.push({
        region: entry.region,
        reason: "no_observations",
        detail: "요청한 기간에 적재된 관측이 없습니다."
      });
      continue;
    }
    withData.push(entry);
  }

  const refuse = (reason: string): PeerComparison => ({
    metric: input.metric,
    unit: input.unit,
    commonYears: [],
    included: [],
    excluded,
    levelRanking: [],
    changeRanking: null,
    changeRankingUnavailableReason: "insufficient_common_years",
    comparabilityBasis: null,
    comparabilityRefusalReason: reason
  });

  if (withData.length < 2) {
    return refuse("비교 가능한 지역이 2개 미만이라 동료 비교를 수행할 수 없습니다.");
  }

  // Candidate bases, scored by how much comparable surface each one yields —
  // regions multiplied by shared years, not regions alone. Maximising region
  // count alone collapses most real comparisons to a single common year, which
  // can rank levels but says nothing about direction, and direction is what a
  // peer comparison is usually asked for. Ties go to the wider group.
  const bases = new Set(
    withData.flatMap((entry) => entry.points.map(compatibilityKey))
  );
  let best: {
    key: string;
    regions: Array<{ region: string; points: ComparableTrendPoint[] }>;
    years: number[];
  } | null = null;
  for (const key of bases) {
    const regions = withData
      .map((entry) => ({
        region: entry.region,
        points: entry.points.filter((point) => compatibilityKey(point) === key)
      }))
      .filter((entry) => entry.points.length > 0);
    if (regions.length < 2) continue;
    let years = regions[0]!.points.map((point) => point.year);
    for (const entry of regions.slice(1)) {
      const present = new Set(entry.points.map((point) => point.year));
      years = years.filter((year) => present.has(year));
    }
    years = [...new Set(years)].sort((left, right) => left - right);
    if (years.length === 0) continue;
    const score = regions.length * years.length;
    const bestScore = best ? best.regions.length * best.years.length : -1;
    const tie = score === bestScore && best && regions.length > best.regions.length;
    if (score > bestScore || tie) best = { key, regions, years };
  }

  if (!best) {
    return refuse(
      "지역 간에 회계 기준·단위·집계 수준이 같으면서 공통으로 관측된 연도가 있는 조합이 없습니다."
    );
  }

  const participating = new Set(best.regions.map((entry) => entry.region));
  for (const entry of withData) {
    if (participating.has(entry.region)) continue;
    excluded.push({
      region: entry.region,
      reason: "incompatible_with_peers",
      detail:
        "다른 지역과 회계 기준·단위·집계 수준이 달라 같은 축에 놓을 수 없습니다."
    });
  }

  const included: PeerRegionSeries[] = best.regions.map((entry) => {
    const points = entry.points
      .filter((point) => best!.years.includes(point.year))
      .sort((left, right) => left.year - right.year);
    return {
      region: entry.region,
      years: points.map((point) => point.year),
      values: points.map((point) => point.value),
      summary: points.length >= 2 ? summarizeTrend(points) : null,
      summaryUnavailableReason: points.length >= 2 ? null : "insufficient_points",
      sourceIds: [...new Set(points.map((point) => point.sourceId))]
    };
  });

  const latestYear = best.years.at(-1)!;
  const levelRanking = included
    .map((series) => ({
      region: series.region,
      year: latestYear,
      value: series.values[series.years.indexOf(latestYear)]!
    }))
    .sort((left, right) => right.value - left.value);

  const changeRanking =
    best.years.length >= 2
      ? included
          .map((series) => ({
            region: series.region,
            changePercent: series.summary?.changePercent ?? null,
            absoluteChange: series.summary?.absoluteChange ?? 0
          }))
          .sort((left, right) => left.absoluteChange - right.absoluteChange)
      : null;

  return {
    metric: input.metric,
    unit: input.unit,
    commonYears: best.years,
    included,
    excluded,
    levelRanking,
    changeRanking,
    changeRankingUnavailableReason:
      changeRanking === null ? "insufficient_common_years" : null,
    comparabilityBasis: best.regions[0]!.points[0]!.compatibility,
    comparabilityRefusalReason: null
  };
}
