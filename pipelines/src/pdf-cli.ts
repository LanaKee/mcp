import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { DatabaseOperationError } from "./db.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { generatedDirectory, repositoryRoot, runEtl } from "./etl.js";
import { loadPdfDatabase } from "./pdf-db.js";
import { normalizePdfCatalog } from "./pdf.js";

function loadEnvironment(): string {
  try {
    loadEnvFile(resolve(repositoryRoot, ".env"));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") throw error;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required. Set it in the environment or repository .env file."
    );
  }
  return process.env.DATABASE_URL;
}

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const limit = positiveInteger(optionValue(args, "--limit"), "--limit");
  const embeddingBatchSize = positiveInteger(
    optionValue(args, "--batch-size"),
    "--batch-size"
  );
  const provider = createEmbeddingProvider({
    provider: optionValue(args, "--provider") ?? "hashed",
    allowExternal: args.includes("--allow-external")
  });
  const databaseUrl = loadEnvironment();
  const etl = await runEtl(true);
  const pdf = await normalizePdfCatalog(etl.result.catalog, {
    limit,
    onProgress: ({ current, total, status, pages, chunks }) => {
      if (current === total || current % 25 === 0) {
        console.error(
          JSON.stringify({ stage: "extract", current, total, status, pages, chunks })
        );
      }
    }
  });
  const load = await loadPdfDatabase(databaseUrl, pdf, provider, {
    applySchema: !args.includes("--skip-schema"),
    embeddingBatchSize,
    onEmbeddingProgress: ({ generated, skipped, total }) => {
      if (generated === 0 || generated === total - skipped || generated % 1000 < 64) {
        console.error(
          JSON.stringify({ stage: "embed", generated, skipped, total })
        );
      }
    }
  });
  await mkdir(generatedDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(generatedDirectory, "pdf.normalized.summary.json"),
      `${JSON.stringify(
        {
          ...pdf.summary,
          failures: pdf.failures.length,
          provider: provider.descriptor,
          load
        },
        null,
        2
      )}\n`,
      "utf8"
    ),
    writeFile(
      resolve(generatedDirectory, "pdf.errors.json"),
      `${JSON.stringify(pdf.failures, null, 2)}\n`,
      "utf8"
    )
  ]);
  console.log(
    JSON.stringify(
      {
        command: "pdf:normalize",
        limit: limit ?? null,
        provider: provider.descriptor,
        extraction: pdf.summary,
        failures: pdf.failures.length,
        load
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  if (error instanceof DatabaseOperationError) {
    console.error(JSON.stringify({ status: "failed", databaseIssue: error.issue }, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
