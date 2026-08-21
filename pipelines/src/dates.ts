function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function monthEndDate(year: number, month: number): string | null {
  if (month < 1 || month > 12) return null;
  return isoDate(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
}

export function parseReferenceDate(
  value: string,
  options: { monthEndWhenDayMissing?: boolean } = {}
): string | null {
  const normalized = value.normalize("NFC").trim();
  const compact = normalized.match(/\b((?:19|20)\d{2})(\d{2})(\d{2})\b/);
  if (compact) {
    return isoDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  }

  const separated = normalized.match(
    /((?:19|20)\d{2})\s*(?:년|[-./])\s*(\d{1,2})\s*(?:월|[-./])?\s*(\d{1,2})?\s*일?/
  );
  if (!separated) return null;
  const year = Number(separated[1]);
  const month = Number(separated[2]);
  if (separated[3]) return isoDate(year, month, Number(separated[3]));
  return options.monthEndWhenDayMissing ? monthEndDate(year, month) : isoDate(year, month, 1);
}
