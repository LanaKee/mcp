import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crawlGbCouncil } from "./gb-council.js";

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

const requestedOut = flag("out");
const outputDirectory = requestedOut
  ? isAbsolute(requestedOut)
    ? requestedOut
    : resolve(process.cwd(), requestedOut)
  : resolve(repositoryRoot, "datasets/gyeongbuk-council");

const onlyCodes = flag("members")
  ?.split(",")
  .map((code) => code.trim())
  .filter(Boolean);

if (!has("accept-terms")) {
  console.error(
    [
      "Refusing to crawl without --accept-terms.",
      "",
      "Review https://council.gb.go.kr terms of use before crawling. The member",
      "roster and bill records are published for public inspection, but the",
      "operator must confirm that before this tool sends any request.",
      "",
      "Example:",
      "  pnpm gb:council:crawl --accept-terms"
    ].join("\n")
  );
  process.exit(2);
}

const result = await crawlGbCouncil({
  outputDirectory,
  termsAcknowledged: true,
  allowUnavailableRobots: has("allow-unavailable-robots"),
  resume: !has("no-resume"),
  ...(onlyCodes && onlyCodes.length > 0 ? { onlySearchCodes: onlyCodes } : {}),
  concurrency: positiveInteger(flag("concurrency"), 2, "concurrency"),
  requestDelayMs: positiveInteger(flag("delay-ms"), 400, "delay-ms"),
  maxPagesPerMember: positiveInteger(flag("max-pages"), 200, "max-pages"),
  onProgress: (message) => console.error(message)
});

console.log(
  JSON.stringify(
    {
      members: result.members.length,
      bills: result.bills.length,
      sponsorLinks: result.sponsors.length,
      memberCsvPath: result.memberCsvPath,
      billCsvPath: result.billCsvPath,
      sponsorCsvPath: result.sponsorCsvPath,
      metadataPath: result.metadataPath
    },
    null,
    2
  )
);
