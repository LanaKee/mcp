import { z } from "zod";

export const dataStatusSchema = z.enum([
  "official_observed",
  "demo_sample",
  "catalog_only"
]);
export const factDataStatusSchema = z.enum([
  "official_observed",
  "demo_sample"
]);
const factDataStatusesSchema = z
  .array(factDataStatusSchema)
  .min(1)
  .max(2)
  .optional();

export const sourceRefSchema = z
  .object({
    sourceId: z.string().min(1),
    title: z.string().min(1),
    provider: z.string().min(1),
    sourceUrl: z.string().url().nullable(),
    collectedAt: z.string().min(1),
    dataStatus: dataStatusSchema,
    isOfficial: z.boolean(),
    locator: z.string().nullable().optional(),
    note: z.string().nullable().optional()
  })
  .strict();

const yearSchema = z.number().int().min(1900).max(2100);

export const populationTrendInputSchema = z
  .object({
    region: z.string().min(1).max(80),
    startYear: yearSchema,
    endYear: yearSchema,
    dataStatuses: factDataStatusesSchema
  })
  .strict()
  .refine((value) => value.startYear <= value.endYear, {
    message: "startYear는 endYear보다 클 수 없습니다."
  });

export const localTaxTrendInputSchema = z
  .object({
    region: z.string().min(1).max(80),
    startYear: yearSchema,
    endYear: yearSchema,
    taxCategory: z.string().min(1).max(80).default("합계"),
    dataStatuses: factDataStatusesSchema
  })
  .strict()
  .refine((value) => value.startYear <= value.endYear, {
    message: "startYear는 endYear보다 클 수 없습니다."
  });

export const comparisonInputSchema = z
  .object({
    startYear: yearSchema,
    endYear: yearSchema,
    regions: z.array(z.string().min(1)).max(30).optional(),
    dataStatuses: factDataStatusesSchema
  })
  .strict()
  .refine((value) => value.startYear < value.endYear, {
    message: "비교에는 서로 다른 시작·종료 연도가 필요합니다."
  });

export const policySearchInputSchema = z
  .object({
    region: z.string().min(1).max(80),
    age: z.number().int().min(0).max(120),
    query: z.string().min(1).max(200),
    stage: z.string().min(1).max(80).optional(),
    asOfDate: z.string().date().optional(),
    dataStatuses: factDataStatusesSchema
  })
  .strict();

export const councilSearchInputSchema = z
  .object({
    query: z.string().min(1).max(300),
    region: z.string().min(1).max(80).optional(),
    council: z.string().min(1).max(100).optional(),
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
    limit: z.number().int().min(1).max(20).default(5),
    dataStatuses: factDataStatusesSchema
  })
  .strict();

/**
 * Press releases are narrative announcements, so this search is deliberately
 * separate from the statistical tools: nothing here may be quoted as a numeric
 * measurement.
 */
export const pressReleaseSearchInputSchema = z
  .object({
    query: z.string().min(1).max(300),
    region: z.string().min(1).max(80).optional(),
    department: z.string().min(1).max(100).optional(),
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
    limit: z.number().int().min(1).max(20).default(5)
  })
  .strict();

/**
 * Per-member legislative activity search for 경상북도의회.
 *
 * This answers "what did this member actually put their name to?", which is
 * only *evidence* toward a question like "did they keep their promise". The
 * council publishes no pledge register, so the tool must never be asked to
 * return a fulfilment verdict — hence there is no `pledge` field here.
 */
export const memberBillSearchInputSchema = z
  .object({
    member: z.string().min(1).max(40).optional(),
    query: z.string().min(1).max(300).optional(),
    /** 'lead' is 대표발의, 'co' is 공동발의. Defaults to both. */
    role: z.enum(["lead", "co", "any"]).default("any"),
    party: z.string().min(1).max(60).optional(),
    committee: z.string().min(1).max(100).optional(),
    billKind: z.string().min(1).max(40).optional(),
    outcome: z.string().min(1).max(40).optional(),
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
    limit: z.number().int().min(1).max(50).default(10)
  })
  .strict()
  .refine((value) => value.member !== undefined || value.query !== undefined, {
    message: "member 또는 query 중 하나는 반드시 지정해야 합니다"
  });

export const verifyClaimInputSchema = z
  .object({
    metric: z.enum(["population", "local_tax"]),
    region: z.string().min(1).max(80),
    year: yearSchema,
    claimedValue: z.number().nonnegative(),
    tolerancePercent: z.number().min(0).max(100).default(1),
    dataStatuses: factDataStatusesSchema
  })
  .strict();

export const sourceContextInputSchema = z
  .object({
    sourceIds: z.array(z.string().min(1)).min(1).max(20)
  })
  .strict();

export const evidenceItemSchema = z
  .object({
    statement: z.string().min(1).max(2000),
    value: z.union([z.string(), z.number()]).optional(),
    sourceIds: z.array(z.string().min(1)).min(1)
  })
  .strict();

export const verifiedAnalysisSchema = z
  .object({
    conclusion: z.string().min(1).max(4000),
    evidence: z.array(evidenceItemSchema).min(1).max(30),
    sources: z.array(sourceRefSchema).min(1).max(30),
    limitations: z.array(z.string().min(1).max(1000)).min(1).max(20),
    verified: z.literal(true)
  })
  .strict();

export const draftPublicDocumentInputSchema = z
  .object({
    documentType: z.enum(["information_request", "participatory_budget"]),
    title: z.string().min(1).max(200),
    requesterContext: z.string().max(1000).optional(),
    verifiedAnalysis: verifiedAnalysisSchema
  })
  .strict();

export const datasetSearchInputSchema = z
  .object({
    query: z.string().min(1).max(300),
    /** Restricts results to datasets that can be joined with this one. */
    joinableWith: z.string().min(1).max(80).optional(),
    /** Excludes narrative material when the caller needs observed facts only. */
    evidenceRole: z.enum(["observed_fact", "narrative_context_only"]).optional(),
    /** Reports coverage for this region only, instead of the union of all regions. */
    region: z.string().min(1).max(40).optional(),
    limit: z.number().int().min(1).max(20).default(5)
  })
  .strict();

export const datasetDescribeInputSchema = z
  .object({
    datasetId: z.string().min(1).max(80),
    /** When false the live coverage probe is skipped (cheaper, but no year range). */
    includeCoverage: z.boolean().default(true),
    /** Reports coverage for this region only, instead of the union of all regions. */
    region: z.string().min(1).max(40).optional()
  })
  .strict();

export type DataStatus = z.infer<typeof dataStatusSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type PopulationTrendInput = z.infer<typeof populationTrendInputSchema>;
export type LocalTaxTrendInput = z.infer<typeof localTaxTrendInputSchema>;
export type ComparisonInput = z.infer<typeof comparisonInputSchema>;
export type PolicySearchInput = z.infer<typeof policySearchInputSchema>;
export type CouncilSearchInput = z.infer<typeof councilSearchInputSchema>;
export type PressReleaseSearchInput = z.infer<
  typeof pressReleaseSearchInputSchema
>;
export type MemberBillSearchInput = z.infer<typeof memberBillSearchInputSchema>;
export type VerifyClaimInput = z.infer<typeof verifyClaimInputSchema>;
export type DraftPublicDocumentInput = z.infer<
  typeof draftPublicDocumentInputSchema
>;
export type DatasetSearchInput = z.infer<typeof datasetSearchInputSchema>;
export type DatasetDescribeInput = z.infer<typeof datasetDescribeInputSchema>;
