import { z } from "zod";

/**
 * 답변 표현 언어.
 *
 * 모델은 문장을 쓰는 대신 이 스키마에 맞는 JSON을 낸다. 화면은 그 JSON을
 * 카드로 그린다. 자유 텍스트를 그대로 렌더링하면 "줄글 답변"으로 되돌아가고,
 * 마크다운을 허용하면 모델이 표 대신 문단을 쓰기 시작하므로 표현 가능한
 * 형태 자체를 제한했다.
 *
 * 상한은 **거절 사유가 아니라 보정 지점**이다. 항목을 아홉 개 쓴 응답을
 * 통째로 버리면 근거를 다 모아 놓고도 화면이 폴백으로 떨어진다. 길이와 개수는
 * 잘라서 받아들이고, 형태가 아예 다른 블록만 버린다.
 */

/** 길이를 넘기면 자른다. 문자열 하나 때문에 답변 전체를 잃지 않기 위해서다. */
const text = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim().slice(0, max) : value),
    z.string().min(1)
  );

/** 개수를 넘기면 앞에서부터 취한다. */
const list = <T extends z.ZodTypeAny>(schema: T, max: number, min = 1) =>
  z.preprocess(
    (value) => (Array.isArray(value) ? value.slice(0, max) : value),
    z.array(schema).min(min)
  );

const shortText = text(120);
const longText = text(400);

export const metricItemSchema = z.object({
  label: shortText,
  value: shortText,
  /** 값 옆의 작은 상태 배지. 예: "적용 대상", "현상 유지 시" */
  badge: shortText.optional(),
  caption: longText.optional(),
  /** 0~1. 값이 있으면 라벨 아래 게이지를 그린다. */
  meter: z.number().min(0).max(1).optional(),
  trend: z.enum(["up", "down", "flat"]).optional()
});

export const blockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("headline"),
    title: longText,
    subtitle: longText.optional()
  }),
  z.object({
    kind: z.literal("metric"),
    title: shortText.optional(),
    label: shortText,
    value: shortText,
    badge: shortText.optional(),
    caption: longText.optional(),
    trend: z.enum(["up", "down", "flat"]).optional()
  }),
  z.object({
    kind: z.literal("metricGrid"),
    title: shortText.optional(),
    subtitle: shortText.optional(),
    items: list(metricItemSchema, 6)
  }),
  z.object({
    kind: z.literal("series"),
    title: shortText,
    unit: shortText.optional(),
    points: list(
      z.object({ label: shortText, value: z.number(), highlight: z.boolean().optional() }),
      36,
      2
    ),
    caption: longText.optional()
  }),
  z.object({
    kind: z.literal("table"),
    title: shortText.optional(),
    columns: list(shortText, 5),
    rows: list(list(z.string().max(300), 5, 0), 12),
    caption: longText.optional()
  }),
  z.object({
    kind: z.literal("bullets"),
    title: shortText.optional(),
    tone: z.enum(["neutral", "caution"]).optional(),
    items: list(longText, 8)
  }),
  z.object({
    kind: z.literal("callout"),
    tone: z.enum(["info", "warn", "danger"]),
    title: shortText.optional(),
    text: longText
  })
]);

/**
 * 형태가 맞지 않는 블록은 버리고 나머지는 살린다.
 *
 * 모델이 여덟 개 중 하나를 이상하게 써도 나머지 일곱 개는 정상적인 근거
 * 표현이다. 전부 버리면 화면 품질이 모델의 최악의 한 줄에 묶인다.
 */
const blocksSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((item) => blockSchema.safeParse(item).success).slice(0, 8)
      : value,
  z.array(blockSchema).min(1)
);

export const answerViewSchema = z.object({
  /** 카드 위에 한 줄로 붙는 요약. */
  summary: longText,
  blocks: blocksSchema
});

export type MetricItem = z.infer<typeof metricItemSchema>;
export type Block = z.infer<typeof blockSchema>;
export type AnswerView = z.infer<typeof answerViewSchema>;

/** 스키마 텍스트. 프롬프트에 그대로 넣어 모델이 형식을 추측하지 않게 한다. */
export const BLOCK_SCHEMA_HINT = `
{
  "summary": "한 문장 요약 (400자 이내)",
  "blocks": [
    { "kind": "headline", "title": "...", "subtitle": "..." },
    { "kind": "metric", "title": "...", "label": "...", "value": "-8.7억", "badge": "현상 유지 시", "caption": "...", "trend": "down" },
    { "kind": "metricGrid", "title": "...", "subtitle": "...", "items": [ { "label": "...", "value": "50% 감면", "badge": "적용 대상", "caption": "...", "meter": 0.6, "trend": "flat" } ] },
    { "kind": "series", "title": "...", "unit": "명", "points": [ { "label": "2020", "value": 12345, "highlight": true } ], "caption": "..." },
    { "kind": "table", "title": "...", "columns": ["...", "..."], "rows": [["...", "..."]], "caption": "..." },
    { "kind": "bullets", "title": "...", "tone": "caution", "items": ["..."] },
    { "kind": "callout", "tone": "warn", "title": "...", "text": "..." }
  ]
}

제한: blocks 최대 8개, metricGrid.items 최대 6개, bullets.items 최대 8개,
table.columns 최대 5개·rows 최대 12행, series.points 최소 2개.
label·value·badge·title은 120자, 그 밖의 문장은 400자 이내로 씁니다.
`.trim();
