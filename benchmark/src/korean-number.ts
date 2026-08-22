/**
 * Recovers quantities from Korean prose so that two arms answering in different
 * styles are graded on the same footing.
 *
 * A grounded answer tends to say "499,839명" while an ungrounded one says
 * "약 50만 명". Both are attempts at the same fact, and a grader that only
 * understood one notation would measure phrasing rather than accuracy.
 */

const MULTIPLIERS: Record<string, number> = {
  조: 1_000_000_000_000,
  억: 100_000_000,
  만: 10_000,
  천: 1_000,
  백: 100,
  십: 10
};

/**
 * Suffixes that mark a number as something other than a measured quantity.
 *
 * Answers are full of dates, ranks and percentages; counting them as candidate
 * values would let a long answer match almost any target by accident.
 */
const DISQUALIFYING_SUFFIX =
  /^(?:년|년도|년대|월|일|시|분|초|세|%|％|퍼센트|포인트|위|회|차|번|배|쪽|페이지|개월|주차|분기)/;

/** Lowest and highest bare integers treated as calendar years rather than data. */
const YEAR_LIKE_MIN = 1900;
const YEAR_LIKE_MAX = 2099;

interface Segment {
  /** Numeric part, commas already removed. */
  numeral: number;
  /** Korean myriad unit attached to this numeral, if any. */
  unit: string | null;
  /** True when the source text wrote the numeral with thousands separators. */
  grouped: boolean;
  start: number;
  end: number;
  disqualified: boolean;
}

const SEGMENT_PATTERN = /(\d[\d,]*(?:\.\d+)?)\s*([조억만천백십])?/g;

function scanSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  SEGMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEGMENT_PATTERN.exec(text)) !== null) {
    const rawNumeral = match[1];
    if (rawNumeral === undefined) continue;
    const unit = match[2] ?? null;
    const numeral = Number(rawNumeral.replace(/,/g, ""));
    if (!Number.isFinite(numeral)) continue;

    const end = match.index + match[0].length;
    const trailing = text.slice(end);
    const grouped = rawNumeral.includes(",");

    // A bare four-digit number in the calendar range is a year far more often
    // than it is a measurement. Grouped numerals are exempt because no one
    // writes a year as "2,024".
    const yearLike =
      unit === null &&
      !grouped &&
      Number.isInteger(numeral) &&
      numeral >= YEAR_LIKE_MIN &&
      numeral <= YEAR_LIKE_MAX;

    segments.push({
      numeral,
      unit,
      grouped,
      start: match.index,
      end,
      disqualified: yearLike || DISQUALIFYING_SUFFIX.test(trailing)
    });
  }
  return segments;
}

/** True when nothing but spaces separates two segments, so they form one figure. */
function contiguous(text: string, left: Segment, right: Segment): boolean {
  return /^\s*$/.test(text.slice(left.end, right.start));
}

function magnitude(unit: string | null): number {
  return unit === null ? 1 : (MULTIPLIERS[unit] ?? 1);
}

/**
 * Extracts every quantity the text asserts, largest-first composition included.
 *
 * "49만 9839명" is one value, not two: Korean writes large numbers as a
 * descending chain of myriad groups, so adjacent segments are folded together
 * while their units keep decreasing.
 */
export function extractKoreanNumbers(text: string): number[] {
  const segments = scanSegments(text).filter((segment) => !segment.disqualified);
  const values: number[] = [];

  let index = 0;
  while (index < segments.length) {
    const head = segments[index];
    if (head === undefined) break;
    let total = head.numeral * magnitude(head.unit);
    let previousMagnitude = magnitude(head.unit);
    let cursor = index + 1;

    while (cursor < segments.length) {
      const next = segments[cursor];
      const previous = segments[cursor - 1];
      if (next === undefined || previous === undefined) break;
      const nextMagnitude = magnitude(next.unit);
      // Only a strictly smaller unit continues the same figure. "10만 20만" is
      // two separate quantities; "10만 2천" is one.
      if (nextMagnitude >= previousMagnitude) break;
      if (!contiguous(text, previous, next)) break;
      total += next.numeral * nextMagnitude;
      previousMagnitude = nextMagnitude;
      cursor += 1;
    }

    values.push(total);
    index = cursor;
  }

  return values;
}

/**
 * Finds the extracted value closest to `target` within tolerance.
 *
 * Any matching value counts, not just the first. That is deliberately generous
 * to the ungrounded arm: a benchmark whose margin depends on strict answer
 * formatting would not survive scrutiny.
 */
export function findMatch(
  values: number[],
  target: number,
  tolerancePercent: number,
  band: { min: number; max: number } | null = null
): number | null {
  const slack = Math.abs(target) * (tolerancePercent / 100);
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const value of values) {
    // The band accommodates series recorded more finely than the question asks:
    // any month of the requested year is a defensible answer for that year.
    const withinBand =
      band !== null &&
      value >= band.min - Math.abs(band.min) * (tolerancePercent / 100) &&
      value <= band.max + Math.abs(band.max) * (tolerancePercent / 100);
    const distance = Math.abs(value - target);
    if (distance > slack && !withinBand) continue;
    if (distance < bestDistance) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
}
