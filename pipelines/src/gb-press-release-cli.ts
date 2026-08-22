import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crawlGbPressReleases } from "./gb-press-release.js";

// pnpm runs workspace scripts from the package directory, so a bare relative
// default would land in pipelines/ instead of the repository's datasets/.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

const since = flag("since") ?? "2020-01-01";
const until = flag("until");
const requestedOut = flag("out");
const outputDirectory = requestedOut
  ? isAbsolute(requestedOut)
    ? requestedOut
    : resolve(process.cwd(), requestedOut)
  : resolve(repositoryRoot, "datasets/gyeongbuk-press-release");

if (!has("accept-terms")) {
  console.error(
    [
      "Refusing to crawl without --accept-terms.",
      "",
      "Review https://www.gb.go.kr terms of use and the board's reuse policy first.",
      "Press releases are published for public redistribution, but the operator",
      "must confirm that before this tool sends any request.",
      "",
      "Example:",
      "  pnpm gb:press:crawl --accept-terms --since=2020-01-01"
    ].join("\n")
  );
  process.exit(2);
}

const result = await crawlGbPressReleases({
  outputDirectory,
  since,
  ...(until ? { until } : {}),
  termsAcknowledged: true,
  allowUnavailableRobots: has("allow-unavailable-robots"),
  resume: !has("no-resume"),
  concurrency: positiveInteger(flag("concurrency"), 2, "concurrency"),
  requestDelayMs: positiveInteger(flag("delay-ms"), 400, "delay-ms"),
  maxOffset: positiveInteger(flag("max-offset"), 20_000, "max-offset"),
  onProgress: (message) => console.error(message)
});

console.log(
  JSON.stringify(
    {
      storedRecords: result.releases.length,
      since,
      until: until ?? null,
      jsonPath: result.jsonPath,
      csvPath: result.csvPath,
      metadataPath: result.metadataPath
    },
    null,
    2
  )
);
