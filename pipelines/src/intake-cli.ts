import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { applySchemaToDatabase, DatabaseOperationError } from "./db.js";
import { generatedDirectory, repositoryRoot } from "./etl.js";
import { recordIntakeRun, summarizeIntakeLedger } from "./intake-db.js";
import { runIntake, type IntakeRunResult } from "./intake.js";
import { normalizeAndLoad } from "./process.js";

type Command = "run" | "status";

const DEFAULT_WORKSPACE = resolve(repositoryRoot, "data/intake");
const DEFAULT_INBOX = resolve(DEFAULT_WORKSPACE, "inbox");
const DEFAULT_DATASETS = resolve(repositoryRoot, "datasets");

function usage(): string {
  return [
    "Usage: intake-cli.ts [run|status] [options]",
    "",
    "  run     ingest every file waiting in the inbox (default command)",
    "  status  summarize what the intake ledger already recorded",
    "",
    "Options:",
    "  --inbox DIR              inbox directory (default data/intake/inbox)",
    "  --workspace DIR          intake workspace (default data/intake)",
    "  --dataset-dir DIR        isolated raw store (default datasets)",
    "  --dry-run                plan only; no files move and nothing is written",
    "  --skip-process           store files but do not normalize or load them",
    "  --skip-ledger            do not write the intake run to PostgreSQL",
    "  --skip-pdf               skip PDF extraction during processing",
    "  --max-bytes N            per-file size limit",
    "  --pdf-limit N            limit PDF extraction to N documents",
    "  --embedding-provider P   hashed (default) or openai",
    "  --embedding-batch-size N embedding batch size",
    "  --allow-external         permit external embedding providers"
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

const VALUE_FLAGS = new Set([
  "--inbox",
  "--workspace",
  "--dataset-dir",
  "--max-bytes",
  "--pdf-limit",
  "--embedding-provider",
  "--embedding-batch-size"
]);

const BOOLEAN_FLAGS = new Set([
  "--dry-run",
  "--skip-process",
  "--skip-ledger",
  "--skip-pdf",
  "--allow-external"
]);

function validateFlags(flags: string[]): void {
  const invalid = flags.find((flag, index) => {
    if (BOOLEAN_FLAGS.has(flag)) return false;
    if (VALUE_FLAGS.has(flag)) return !flags[index + 1];
    if (index > 0 && VALUE_FLAGS.has(flags[index - 1]!)) return false;
    return ![...VALUE_FLAGS].some((name) => flag.startsWith(`${name}=`));
  });
  if (invalid) throw new Error(`Unknown option: ${invalid}\n${usage()}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((argument) => argument !== "--");
  const command: Command = argv[0] === "status" ? "status" : "run";
  const flags = argv[0] === "run" || argv[0] === "status" ? argv.slice(1) : argv;
  validateFlags(flags);

  if (command === "status") {
    console.log(
      JSON.stringify(
        { command, ledger: await summarizeIntakeLedger(databaseUrl()) },
        null,
        2
      )
    );
    return;
  }

  const dryRun = flags.includes("--dry-run");
  const skipProcess = flags.includes("--skip-process");
  const skipLedger = flags.includes("--skip-ledger");
  const workspaceDirectory = resolve(
    repositoryRoot,
    optionValue(flags, "--workspace") ?? DEFAULT_WORKSPACE
  );
  const inboxDirectory = resolve(
    repositoryRoot,
    optionValue(flags, "--inbox") ?? DEFAULT_INBOX
  );
  const datasetDirectory = resolve(
    repositoryRoot,
    optionValue(flags, "--dataset-dir") ?? DEFAULT_DATASETS
  );

  const intake: IntakeRunResult = await runIntake({
    inboxDirectory,
    datasetDirectory,
    repositoryRoot,
    workspaceDirectory,
    dryRun,
    maxBytes: positiveInteger(optionValue(flags, "--max-bytes"), "--max-bytes"),
    storeIndexCachePath: resolve(generatedDirectory, "intake-store-index.json")
  });

  const stored = intake.counts.accepted + intake.counts.revision;
  let ledger = null;
  let schemaApplied = false;
  if (!dryRun && !skipLedger) {
    await applySchemaToDatabase(databaseUrl());
    schemaApplied = true;
    ledger = await recordIntakeRun(databaseUrl(), intake);
  }

  // Re-normalizing an unchanged store would only burn time, so processing runs
  // exactly when new bytes actually entered the store.
  let processed = null;
  if (!dryRun && !skipProcess && stored > 0) {
    processed = await normalizeAndLoad({
      databaseUrl: databaseUrl(),
      source: "regenerate",
      applySchema: !schemaApplied,
      skipPdf: flags.includes("--skip-pdf"),
      pdfLimit: positiveInteger(optionValue(flags, "--pdf-limit"), "--pdf-limit"),
      embeddingProvider: optionValue(flags, "--embedding-provider"),
      allowExternal: flags.includes("--allow-external"),
      embeddingBatchSize: positiveInteger(
        optionValue(flags, "--embedding-batch-size"),
        "--embedding-batch-size"
      ),
      datasetDirectory,
      generatedDirectory: resolve(workspaceDirectory, "generated"),
      onExtractionProgress: ({ current, total, status, pages, chunks }) => {
        if (current === total || current % 25 === 0) {
          console.error(
            JSON.stringify({ stage: "extract", current, total, status, pages, chunks })
          );
        }
      }
    });
  }

  console.log(
    JSON.stringify(
      {
        command,
        mode: intake.mode,
        runId: intake.runId,
        inbox: intake.inboxDirectory,
        counts: intake.counts,
        manifest: intake.manifestPath,
        decisions: intake.decisions.map((decision) => ({
          fileName: decision.fileName,
          action: decision.action,
          contentKind: decision.contentKind,
          storedPath: decision.storedPath,
          duplicateOfPath: decision.duplicateOfPath,
          rejectionCode: decision.rejectionCode
        })),
        ledger,
        processed,
        processingSkippedReason:
          processed === null
            ? dryRun
              ? "dry_run"
              : skipProcess
                ? "skip_process_flag"
                : "no_new_files"
            : null
      },
      null,
      2
    )
  );
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
