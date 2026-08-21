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

export type DataStatus = z.infer<typeof dataStatusSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type PopulationTrendInput = z.infer<typeof populationTrendInputSchema>;
export type LocalTaxTrendInput = z.infer<typeof localTaxTrendInputSchema>;
export type ComparisonInput = z.infer<typeof comparisonInputSchema>;
export type PolicySearchInput = z.infer<typeof policySearchInputSchema>;
export type CouncilSearchInput = z.infer<typeof councilSearchInputSchema>;
export type VerifyClaimInput = z.infer<typeof verifyClaimInputSchema>;
export type DraftPublicDocumentInput = z.infer<
  typeof draftPublicDocumentInputSchema
>;
