import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * HTTP crawling primitives shared by the public-site crawlers.
 *
 * These were written for the Pohang council crawler first; the Gyeongbuk press
 * release crawler needs exactly the same politeness, retry and atomic-write
 * behaviour, so they live here rather than being copied.
 */

export function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&#(\d+);/gu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10))
    )
    .replace(/&([a-z]+);/giu, (match, name: string) => named[name.toLowerCase()] ?? match);
}

/** Strips markup and collapses whitespace into a single NFC-normalised line. */
export function normalizedText(value: string): string {
  return decodeHtml(value.replace(/<br\s*\/?>/giu, " ").replace(/<[^>]*>/gu, " "))
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Strips markup while preserving block structure as newlines, for body copy
 * where paragraph breaks carry meaning.
 */
export function normalizedBlockText(value: string): string {
  const withBreaks = value
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, " ");
  return decodeHtml(withBreaks)
    .normalize("NFC")
    .replace(/\u00a0/gu, " ")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, path);
}

/**
 * Returns whether the path is crawlable, or `null` when robots.txt carries no
 * usable group. `null` is deliberately distinct from `true`: the caller must
 * decide whether an uninterpretable policy is acceptable.
 */
export function robotsAllowsPath(
  contents: string,
  path: string,
  userAgent: string
): boolean | null {
  const groups: Array<{
    agents: string[];
    rules: Array<{ allow: boolean; path: string }>;
  }> = [];
  let current:
    | {
        agents: string[];
        rules: Array<{ allow: boolean; path: string }>;
      }
    | null = null;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (field === "allow" || field === "disallow")) {
      current.rules.push({ allow: field === "allow", path: value });
    }
  }
  if (groups.length === 0) return null;
  const normalizedAgent = userAgent.toLowerCase();
  const matching = groups.filter((group) =>
    group.agents.some((agent) => agent === "*" || normalizedAgent.includes(agent))
  );
  if (matching.length === 0) return true;
  const rules = matching
    .flatMap((group) => group.rules)
    .filter((rule) => rule.path && path.startsWith(rule.path))
    .sort(
      (left, right) =>
        right.path.length - left.path.length ||
        Number(right.allow) - Number(left.allow)
    );
  return rules[0]?.allow ?? true;
}

/** Serialises requests so at least `intervalMs` elapses between each start. */
export function createRequestGate(intervalMs: number): () => Promise<void> {
  let previous = Promise.resolve();
  let lastStartedAt = 0;
  return async () => {
    const turn = previous.then(async () => {
      const waitMs = Math.max(0, lastStartedAt + intervalMs - Date.now());
      if (waitMs > 0) {
        await new Promise((done) => setTimeout(done, waitMs));
      }
      lastStartedAt = Date.now();
    });
    previous = turn.catch(() => undefined);
    await turn;
  };
}

export async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
  retries: number,
  delayMs: number,
  waitForRequest: () => Promise<void>,
  userAgent: string
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await waitForRequest();
      const response = await fetchImpl(url, {
        headers: { "user-agent": userAgent },
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((done) => setTimeout(done, delayMs * 2 ** attempt));
      }
    }
  }
  throw new Error(`Failed to fetch ${url}: ${String(lastError)}`);
}

export async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await mapper(values[index] as T, index);
      }
    })
  );
  return output;
}
