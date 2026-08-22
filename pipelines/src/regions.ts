/**
 * Gyeongbuk-facing view of the province-agnostic region adapter.
 *
 * The rules and the name list now live in region-adapter.ts; this module only
 * binds them to Gyeongbuk so existing callers keep a single, unambiguous entry
 * point and cannot accidentally resolve a name against the wrong province.
 */
import {
  gyeongbukAdapter,
  type AdministrativeRegion
} from "./region-adapter.js";

export type GyeongbukRegion = AdministrativeRegion;

export const GYEONGBUK_REGIONS: readonly GyeongbukRegion[] =
  gyeongbukAdapter.regions;

export function resolveGyeongbukRegion(value: string): GyeongbukRegion | null {
  return gyeongbukAdapter.resolve(value);
}

export function inferGyeongbukRegion(
  ...values: Array<string | null | undefined>
): GyeongbukRegion | null {
  return gyeongbukAdapter.infer(...values);
}
