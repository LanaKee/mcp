import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { applyDatabaseSchema, DatabaseOperationError } from "./db.js";
import { repositoryRoot } from "./etl.js";
import {
  approveProcessingVersion,
  createPurgePlan,
  executePurge,
  minimumRetentionDays,
  retireProcessingVersion,
  runPostPurgeMaintenance,
  storageCapacityReport,
  withLifecycleClient
} from "./lifecycle.js";

type Command =
  | "status"
  | "approve"
  | "retire"
  | "purge"
  | "audit-purge"
  | "maintain";

function usage(): string {
  return [
    "Usage: lifecycle-cli.ts <command> [options]",
    "  status",
    "  approve --version KEY --actor ACTOR --reason TEXT",
    "  retire --version KEY --actor ACTOR --reason TEXT",
    "  purge --actor ACTOR [--retention-days N]",
    "  purge --execute --confirm TOKEN [--batch-size N] [--max-rows N] [--max-runtime-seconds N]",
    "  audit-purge --actor ACTOR",
    "  audit-purge --execute --confirm TOKEN [bounded execution options]",
    "  maintain --actor ACTOR [--tables a,b] [--statement-timeout-ms N]",
    "  maintain --vacuum --confirm-vacuum --actor ACTOR [bounded options]",
    "All purge commands are dry-run unless --execute and an exact confirmation token are supplied."
  ].join("\n");
}

function loadDatabaseUrl(): string {
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

function optionValue(args: string[], name: string): string | undefined {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], name: string): string {
  const value = optionValue(args, name);
  if (!value) throw new Error(`${name} is required\n${usage()}`);
  return value;
}

function integer(
  args: string[],
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = optionValue(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function validateFlags(command: Command, args: string[]): void {
  const valueFlags = new Set([
    "--version",
    "--actor",
    "--reason",
    "--retention-days",
    "--confirm",
    "--batch-size",
    "--max-rows",
    "--max-runtime-seconds",
    "--tables",
    "--statement-timeout-ms"
  ]);
  const booleanFlags = new Set([
    "--execute",
    "--skip-schema",
    "--vacuum",
    "--confirm-vacuum"
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (booleanFlags.has(value)) continue;
    if ([...valueFlags].some((name) => value.startsWith(`${name}=`))) continue;
    if (valueFlags.has(value)) {
      if (!args[index + 1]) throw new Error(`${value} requires a value`);
      index += 1;
      continue;
    }
    throw new Error(`Unknown ${command} option: ${value}\n${usage()}`);
  }
}

async function main(): Promise<void> {
  const [rawCommand, ...rawArgs] = process.argv
    .slice(2)
    .filter((argument) => argument !== "--");
  if (
    !["status", "approve", "retire", "purge", "audit-purge", "maintain"].includes(
      rawCommand ?? ""
    )
  ) {
    throw new Error(usage());
  }
  const command = rawCommand as Command;
  validateFlags(command, rawArgs);
  const databaseUrl = loadDatabaseUrl();
  const result = await withLifecycleClient(databaseUrl, async (client) => {
    if (!rawArgs.includes("--skip-schema")) await applyDatabaseSchema(client);
    if (command === "status") return storageCapacityReport(client);
    if (command === "approve") {
      return approveProcessingVersion(
        client,
        required(rawArgs, "--version"),
        required(rawArgs, "--actor"),
        required(rawArgs, "--reason")
      );
    }
    if (command === "retire") {
      return retireProcessingVersion(
        client,
        required(rawArgs, "--version"),
        required(rawArgs, "--actor"),
        required(rawArgs, "--reason")
      );
    }
    if (command === "maintain") {
      return runPostPurgeMaintenance(client, {
        operation: rawArgs.includes("--vacuum") ? "vacuum" : "analyze",
        actor: required(rawArgs, "--actor"),
        tables: optionValue(rawArgs, "--tables")
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        statementTimeoutMs: integer(
          rawArgs,
          "--statement-timeout-ms",
          600_000,
          1_000,
          900_000
        ),
        confirmVacuum: rawArgs.includes("--confirm-vacuum")
      });
    }
    const operation =
      command === "purge" ? "stale_purge" : "audit_purge";
    if (!rawArgs.includes("--execute")) {
      return createPurgePlan(client, {
        operation,
        retentionDays:
          operation === "stale_purge"
            ? integer(
                rawArgs,
                "--retention-days",
                minimumRetentionDays(),
                1,
                3650
              )
            : undefined,
        actor: required(rawArgs, "--actor")
      });
    }
    return executePurge(client, required(rawArgs, "--confirm"), {
      batchSize: integer(rawArgs, "--batch-size", 500, 1, 5000),
      maxRows: integer(rawArgs, "--max-rows", 10_000, 1, 100_000),
      maxRuntimeMs:
        integer(rawArgs, "--max-runtime-seconds", 60, 1, 900) * 1000
    });
  });
  console.log(JSON.stringify({ command, result }, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof DatabaseOperationError) {
    console.error(
      JSON.stringify({ status: "failed", databaseIssue: error.issue }, null, 2)
    );
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
