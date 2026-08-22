import type {
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
  if (points.length === 0) {
    throw new Error("추세를 계산할 데이터가 없습니다.");
  }
  const sorted = [...points].sort((a, b) => a.year - b.year);
  const start = sorted[0];
  const end = sorted.at(-1);
  if (!start || !end) {
    throw new Error("추세 시작·종료 값을 찾을 수 없습니다.");
  }
  const absoluteChange = end.value - start.value;
  const changePercent =
    start.value === 0 ? 0 : Number(((absoluteChange / start.value) * 100).toFixed(2));
  return {
    startValue: start.value,
    endValue: end.value,
    absoluteChange,
    changePercent,
    direction:
      absoluteChange > 0 ? "increase" : absoluteChange < 0 ? "decrease" : "flat"
  };
}

export function comparePopulationAndTax(
  population: PopulationRecord[],
  taxes: LocalTaxRecord[],
  startYear: number,
  endYear: number,
  regionFilter?: string[]
) {
  const filters = regionFilter?.map(normalizeRegionName);
  const regionIds = new Set(population.map((record) => record.regionId));

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
      const regionName = populationRows[0]?.regionName ?? regionId;
      if (
        filters &&
        !filters.some((filter) => normalizeRegionName(regionName).includes(filter))
      ) {
        return null;
      }
      if (
        !populationRows.some((record) => record.year === startYear) ||
        !populationRows.some((record) => record.year === endYear) ||
        !taxRows.some((record) => record.fiscalYear === startYear) ||
        !taxRows.some((record) => record.fiscalYear === endYear)
      ) {
        return null;
      }
      const populationTrend = summarizeTrend(
        populationRows.map((record) => ({
          year: record.year,
          value: record.populationTotal,
          sourceId: record.sourceId
        }))
      );
      const taxTrend = summarizeTrend(
        taxRows.map((record) => ({
          year: record.fiscalYear,
          value: record.revenueAmountWon,
          sourceId: record.sourceId
        }))
      );
      return {
        regionId,
        regionName,
        populationTrend,
        taxTrend,
        populationDataStatuses: [
          ...new Set(populationRows.map((record) => record.dataStatus))
        ],
        taxDataStatuses: [
          ...new Set(taxRows.map((record) => record.dataStatus))
        ],
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
        matches: populationTrend.direction === "decrease" && taxTrend.direction === "increase"
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => {
      if (a.matches !== b.matches) return a.matches ? -1 : 1;
      return b.taxTrend.changePercent - a.taxTrend.changePercent;
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
