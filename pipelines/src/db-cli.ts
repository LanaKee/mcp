import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { applySchemaToDatabase, DatabaseOperationError } from "./db.js";
import { repositoryRoot } from "./etl.js";
import { normalizeAndLoad } from "./process.js";

type Command = "schema" | "load" | "normalize";

function usage(): string {
  return [
    "Usage: db-cli.ts <schema|load|normalize> [--skip-schema] [--skip-pdf]",
    "       [--pdf-limit N] [--embedding-provider hashed|openai] [--allow-external]",
    "  schema          apply the repository schema and migrations",
    "  load            load existing data/generated artifacts",
    "  normalize       regenerate ETL artifacts, apply schema, and load them"
  ].join("\n");
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

function databaseUrl(): string {
  try {
    loadEnvFile(resolve(repositoryRoot, ".env"));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") throw error;
  }
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "DATABASE_URL is required. Set it in the environment or repository .env file."
    );
  }
  return value;
}

async function main(): Promise<void> {
  const [rawCommand, ...rawFlags] = process.argv.slice(2);
  const flags = rawFlags.filter((flag) => flag !== "--");
  if (!["schema", "load", "normalize"].includes(rawCommand ?? "")) {
    throw new Error(usage());
  }
  const valueFlags = new Set([
    "--pdf-limit",
    "--embedding-provider",
    "--embedding-batch-size"
  ]);
  const booleanFlags = new Set([
    "--skip-schema",
    "--skip-pdf",
    "--allow-external"
  ]);
  const invalidFlag = flags.find((flag, index) => {
    if (booleanFlags.has(flag)) return false;
    if (valueFlags.has(flag)) return !flags[index + 1];
    if (index > 0 && valueFlags.has(flags[index - 1]!)) return false;
    return ![...valueFlags].some((name) => flag.startsWith(`${name}=`));
  });
  if (invalidFlag) throw new Error(`Unknown option: ${invalidFlag}\n${usage()}`);

  const command = rawCommand as Command;
  const url = databaseUrl();
  if (command === "schema") {
    await applySchemaToDatabase(url);
    console.log(JSON.stringify({ command, status: "succeeded" }, null, 2));
    return;
  }

  const skipSchema = flags.includes("--skip-schema");
  const result = await normalizeAndLoad({
    databaseUrl: url,
    source: command === "normalize" ? "regenerate" : "generated",
    applySchema: !skipSchema,
    skipPdf: flags.includes("--skip-pdf"),
    pdfLimit: positiveInteger(optionValue(flags, "--pdf-limit"), "--pdf-limit"),
    embeddingProvider: optionValue(flags, "--embedding-provider"),
    allowExternal: flags.includes("--allow-external"),
    embeddingBatchSize: positiveInteger(
      optionValue(flags, "--embedding-batch-size"),
      "--embedding-batch-size"
    ),
    onExtractionProgress: ({ current, total, status, pages, chunks }) => {
      if (current === total || current % 25 === 0) {
        console.error(
          JSON.stringify({ stage: "extract", current, total, status, pages, chunks })
        );
      }
    }
  });
  console.log(
    JSON.stringify(
      {
        command,
        officialOnly: true,
        schemaApplied: !skipSchema,
        ...result
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
