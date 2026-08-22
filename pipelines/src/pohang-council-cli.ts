import { resolve } from "node:path";
import { crawlPohangBills } from "./pohang-council.js";

const argumentsToParse = process.argv.slice(2);
const knownArguments = new Set([
  "--output",
  "--concurrency",
  "--delay-ms",
  "--acknowledge-terms",
  "--acknowledge-robots-unavailable"
]);
for (let index = 0; index < argumentsToParse.length; index += 1) {
  const argument = argumentsToParse[index] ?? "";
  if (!knownArguments.has(argument)) {
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (
    argument === "--output" ||
    argument === "--concurrency" ||
    argument === "--delay-ms"
  ) {
    const value = argumentsToParse[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
  }
}
const outputIndex = argumentsToParse.indexOf("--output");
const concurrencyIndex = argumentsToParse.indexOf("--concurrency");
const delayIndex = argumentsToParse.indexOf("--delay-ms");
const outputDirectory = resolve(
  outputIndex >= 0 ? (argumentsToParse[outputIndex + 1] ?? "") : "datasets/pohang-council"
);
const concurrency = concurrencyIndex >= 0
  ? Number(argumentsToParse[concurrencyIndex + 1])
  : 2;
const requestDelayMs = delayIndex >= 0 ? Number(argumentsToParse[delayIndex + 1]) : 500;
const termsAcknowledged = argumentsToParse.includes("--acknowledge-terms");
const allowUnavailableRobots = argumentsToParse.includes(
  "--acknowledge-robots-unavailable"
);

if (!Number.isFinite(requestDelayMs) || requestDelayMs < 250) {
  throw new Error("--delay-ms must be at least 250");
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error("--concurrency must be an integer between 1 and 4");
}
if (!termsAcknowledged) {
  throw new Error(
    "Review the public site's terms and crawl policy, then pass --acknowledge-terms"
  );
}

const result = await crawlPohangBills({
  outputDirectory,
  concurrency,
  requestDelayMs,
  termsAcknowledged,
  allowUnavailableRobots,
  onProgress: (message) => process.stderr.write(`${message}\n`)
});
process.stdout.write(
  `${JSON.stringify({
    outputDirectory,
    recordCount: result.bills.length,
    jsonPath: result.jsonPath,
    csvPath: result.csvPath,
    metadataPath: result.metadataPath
  }, null, 2)}\n`
);
