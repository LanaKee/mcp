import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import {
  applySchemaToDatabase,
  DatabaseOperationError,
  loadDatabase
} from "./db.js";
import {
  generatedDirectory,
  repositoryRoot,
  runEtl,
  type EtlResult
} from "./etl.js";
import { createLoadPlan } from "./load-plan.js";

type Command = "schema" | "load" | "normalize";

function usage(): string {
  return [
    "Usage: db-cli.ts <schema|load|normalize> [--official-only] [--include-demo] [--skip-schema]",
    "  schema          apply the repository schema and migrations",
    "  load            load existing data/generated artifacts",
    "  normalize       regenerate ETL artifacts, apply schema, and load them"
  ].join("\n");
}

function databaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    try {
      loadEnvFile(resolve(repositoryRoot, ".env"));
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "ENOENT") throw error;
    }
  }
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "DATABASE_URL is required. Set it in the environment or repository .env file."
    );
  }
  return value;
}

async function readGeneratedEtl(): Promise<EtlResult> {
  const [catalog, population, council, errors] = await Promise.all(
    ["catalog.json", "population.normalized.json", "council.normalized.json", "errors.json"].map(
      async (file) =>
        JSON.parse(await readFile(resolve(generatedDirectory, file), "utf8")) as unknown
    )
  );
  return {
    catalog: catalog as EtlResult["catalog"],
    population: population as EtlResult["population"],
    council: council as EtlResult["council"],
    errors: errors as EtlResult["errors"]
  };
}

async function main(): Promise<void> {
  const [rawCommand, ...rawFlags] = process.argv.slice(2);
  const flags = rawFlags.filter((flag) => flag !== "--");
  if (!["schema", "load", "normalize"].includes(rawCommand ?? "")) {
    throw new Error(usage());
  }
  const allowedFlags = new Set(["--official-only", "--include-demo", "--skip-schema"]);
  const invalidFlag = flags.find((flag) => !allowedFlags.has(flag));
  if (invalidFlag) throw new Error(`Unknown option: ${invalidFlag}\n${usage()}`);

  const command = rawCommand as Command;
  const url = databaseUrl();
  if (command === "schema") {
    await applySchemaToDatabase(url);
    console.log(JSON.stringify({ command, status: "succeeded" }, null, 2));
    return;
  }

  const includeDemo = !flags.includes("--official-only");
  const skipSchema = flags.includes("--skip-schema");
  const etl =
    command === "normalize"
      ? (await runEtl(true)).result
      : await readGeneratedEtl();
  const plan = await createLoadPlan(etl, { includeDemo });
  const load = await loadDatabase(url, plan, { applySchema: !skipSchema });
  console.log(
    JSON.stringify(
      {
        command,
        includeDemo,
        schemaApplied: !skipSchema,
        normalized: {
          files: etl.catalog.length,
          population: etl.population.length,
          council: etl.council.length,
          errors: etl.errors.length
        },
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
