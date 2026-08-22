import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { Client } from "pg";
import { applySchemaToDatabase } from "./db.js";
import { repositoryRoot } from "./etl.js";
import { recordIntakeRun } from "./intake-db.js";
import { runIntake } from "./intake.js";
import { normalizeAndLoad } from "./process.js";

interface Phase {
  name: string;
  elapsedMs: number;
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function timed<T>(name: string, phases: Phase[], action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await action();
  phases.push({ name, elapsedMs: Math.round(performance.now() - started) });
  return result;
}

async function main(): Promise<void> {
  loadEnvFile(resolve(repositoryRoot, ".env"));
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl) throw new Error("DATABASE_URL이 필요합니다.");
  const input = option("--file");
  if (!input) {
    throw new Error("Usage: measure-intake-onboarding.ts --file PATH [--out PATH]");
  }
  const inputPath = resolve(repositoryRoot, input);
  const runRoot = await mkdtemp(resolve(tmpdir(), "gb-intake-onboarding-"));
  const inbox = resolve(runRoot, "inbox");
  const datasets = resolve(runRoot, "datasets");
  const workspace = resolve(runRoot, "workspace");
  const generated = resolve(runRoot, "generated");
  await Promise.all([mkdir(inbox), mkdir(datasets), mkdir(workspace)]);
  await copyFile(inputPath, resolve(inbox, basename(inputPath)));

  const databaseName = `gb_intake_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const adminUrl = new URL(configuredUrl);
  adminUrl.pathname = "/postgres";
  const databaseUrl = new URL(configuredUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const phases: Phase[] = [];
  const overallStarted = performance.now();
  let databaseCreated = false;

  try {
    await admin.connect();
    await timed("create_empty_database", phases, async () => {
      await admin.query(`CREATE DATABASE ${databaseName}`);
      databaseCreated = true;
    });
    const intake = await timed("validate_and_store_raw", phases, () =>
      runIntake({
        inboxDirectory: inbox,
        datasetDirectory: datasets,
        repositoryRoot,
        workspaceDirectory: workspace,
        dryRun: false,
        storeIndexCachePath: resolve(workspace, "store-index.json")
      })
    );
    await timed("apply_schema", phases, () => applySchemaToDatabase(databaseUrl.toString()));
    const ledger = await timed("record_intake_ledger", phases, () =>
      recordIntakeRun(databaseUrl.toString(), intake)
    );
    const processed = await timed("normalize_and_load", phases, () =>
      normalizeAndLoad({
        databaseUrl: databaseUrl.toString(),
        source: "regenerate",
        applySchema: false,
        skipPdf: true,
        datasetDirectory: datasets,
        generatedDirectory: generated
      })
    );

    const probe = new Client({ connectionString: databaseUrl.toString() });
    await probe.connect();
    const counts = await probe.query<{
      sources: string;
      intake_files: string;
      population_facts: string;
      tax_facts: string;
    }>(`
      SELECT
        (SELECT count(*) FROM data_source)::text AS sources,
        (SELECT count(*) FROM raw_intake_file)::text AS intake_files,
        (SELECT count(*) FROM population_observation)::text AS population_facts,
        (SELECT count(*) FROM local_tax_revenue)::text AS tax_facts
    `);
    await probe.end();

    const report = {
      measuredAt: new Date().toISOString(),
      input: {
        path: input,
        fileName: basename(inputPath)
      },
      isolation: {
        emptyDatabase: true,
        temporaryDatabaseDroppedAfterMeasurement: true,
        productionDatasetStoreModified: false
      },
      elapsedMs: Math.round(performance.now() - overallStarted),
      phases,
      intake: {
        counts: intake.counts,
        decisions: intake.decisions.map((decision) => ({
          action: decision.action,
          contentKind: decision.contentKind,
          encoding: decision.encoding,
          storedPath: decision.storedPath,
          rejectionCode: decision.rejectionCode
        }))
      },
      ledger,
      normalized: processed.normalized,
      databaseRows: {
        dataSource: Number(counts.rows[0]?.sources ?? 0),
        rawIntakeFile: Number(counts.rows[0]?.intake_files ?? 0),
        populationObservation: Number(counts.rows[0]?.population_facts ?? 0),
        localTaxRevenue: Number(counts.rows[0]?.tax_facts ?? 0)
      }
    };
    const out = resolve(
      repositoryRoot,
      option("--out") ?? `benchmark/reports/intake-onboarding-${Date.now()}.json`
    );
    await mkdir(resolve(out, ".."), { recursive: true });
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ report: out, ...report }, null, 2));
  } finally {
    if (databaseCreated) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [databaseName]
      );
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    }
    await admin.end().catch(() => undefined);
    await rm(runRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`[intake-onboarding] 실패: ${(error as Error).message}`);
  process.exitCode = 1;
});
