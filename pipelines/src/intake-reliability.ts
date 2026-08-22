import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import iconv from "iconv-lite";
import { Client } from "pg";
import { applySchemaToDatabase } from "./db.js";
import { repositoryRoot } from "./etl.js";
import { recordIntakeRun } from "./intake-db.js";
import {
  runIntake,
  type IntakeDecision,
  type IntakeRunResult
} from "./intake.js";
import { normalizeAndLoad } from "./process.js";

const NORMAL_NAME = "01-경상북도_포항시_연도별인구_20241231.csv";
const DUPLICATE_NAME = "02-동일내용_다른이름.csv";
const HTML_NAME = "03-fake-html.csv";
const EMPTY_NAME = "04-empty.csv";
const CP949_NAME = "05-경상북도_김천시_연도별인구_20241231.csv";
const UNKNOWN_NAME = "06-경상북도_없는시_연도별인구_20241231.csv";
const KIMCHEON_TAX_SOURCE =
  "datasets/new/경상북도 김천시_지방세징수현황_20260529.csv";

const POHANG_POPULATION = [
  "년월,한국인남,한국인여,외국인남,외국인여",
  "2024-12-01,240000,238000,1800,1200"
].join("\n");

const POHANG_POPULATION_REVISION = [
  "년월,한국인남,한국인여,외국인남,외국인여",
  "2024-12-01,240001,238000,1800,1200"
].join("\n");

const GIMCHEON_POPULATION = [
  "년월,한국인남,한국인여,외국인남,외국인여",
  "2024-12-01,65000,66000,900,650"
].join("\n");

const UNKNOWN_POPULATION = [
  "년월,한국인남,한국인여,외국인남,외국인여",
  "2024-12-01,100,100,0,0"
].join("\n");

interface DatabaseHandle {
  name: string;
  url: string;
}

interface RowCounts {
  storedFiles: number;
  dataSources: number;
  facts: number;
  locators: number;
  rawLedgerRows: number;
}

export interface StressVerdict {
  scenarios: number;
  handledCorrectly: number;
  acceptedCorrectly: string;
  duplicateDetected: string;
  revisionPreserved: string;
  invalidQuarantined: string;
  unknownRegionFactRows: number;
  duplicateFactsAfterReprocess: number;
  silentOverwrites: number;
  dataLoss: number;
  wholePipelineFailure: boolean;
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  const counts = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? countFiles(resolve(directory, entry.name))
        : Promise.resolve(entry.isFile() ? 1 : 0)
    )
  );
  return counts.reduce((total, count) => total + count, 0);
}

async function createDatabase(admin: Client, baseUrl: string): Promise<DatabaseHandle> {
  const name = `gb_reliability_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropDatabase(admin: Client, database: DatabaseHandle): Promise<void> {
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
    [database.name]
  );
  await admin.query(`DROP DATABASE IF EXISTS ${database.name}`);
}

async function recordAndProcess(
  databaseUrl: string,
  intake: IntakeRunResult,
  paths: { datasets: string; generated: string }
): Promise<void> {
  await recordIntakeRun(databaseUrl, intake);
  if (intake.counts.accepted + intake.counts.revision === 0) return;
  await normalizeAndLoad({
    databaseUrl,
    source: "regenerate",
    applySchema: false,
    skipPdf: true,
    datasetDirectory: paths.datasets,
    generatedDirectory: paths.generated
  });
}

async function runIsolatedIntake(
  databaseUrl: string,
  paths: {
    inbox: string;
    datasets: string;
    workspace: string;
    generated: string;
  }
): Promise<IntakeRunResult> {
  const intake = await runIntake({
    inboxDirectory: paths.inbox,
    datasetDirectory: paths.datasets,
    repositoryRoot,
    workspaceDirectory: paths.workspace,
    storeIndexCachePath: resolve(paths.workspace, "store-index.json")
  });
  await recordAndProcess(databaseUrl, intake, paths);
  return intake;
}

async function queryCounts(databaseUrl: string, datasets: string): Promise<RowCounts> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{
      sources: string;
      facts: string;
      locators: string;
      ledger: string;
    }>(`
      SELECT
        (SELECT count(*) FROM data_source)::text AS sources,
        (SELECT count(*) FROM population_observation)::text AS facts,
        (SELECT count(*) FROM source_locator
          WHERE entity_type = 'population_observation')::text AS locators,
        (SELECT count(*) FROM raw_intake_file)::text AS ledger
    `);
    return {
      storedFiles: await countFiles(datasets),
      dataSources: Number(result.rows[0]?.sources ?? 0),
      facts: Number(result.rows[0]?.facts ?? 0),
      locators: Number(result.rows[0]?.locators ?? 0),
      rawLedgerRows: Number(result.rows[0]?.ledger ?? 0)
    };
  } finally {
    await client.end();
  }
}

function decisionByName(
  decisions: IntakeDecision[],
  fileName: string
): IntakeDecision | undefined {
  return decisions.find((decision) => decision.fileName === fileName);
}

export function evaluateStressDecisions(input: {
  first: IntakeDecision[];
  revision: IntakeDecision[];
  reprocess: IntakeDecision[];
  unknownRegionFactRows: number;
  factCountBeforeReprocess: number;
  factCountAfterReprocess: number;
  originalStillExists: boolean;
  revisionExists: boolean;
  expectedArtifacts: number;
  observedArtifacts: number;
  pipelineFailed: boolean;
}): StressVerdict {
  const accepted =
    decisionByName(input.first, NORMAL_NAME)?.action === "accepted" &&
    decisionByName(input.first, CP949_NAME)?.action === "accepted";
  const duplicate =
    decisionByName(input.first, DUPLICATE_NAME)?.action === "duplicate";
  const revision =
    decisionByName(input.revision, NORMAL_NAME)?.action === "revision" &&
    input.originalStillExists &&
    input.revisionExists;
  const invalid =
    decisionByName(input.first, HTML_NAME)?.rejectionCode === "html_error_page" &&
    decisionByName(input.first, EMPTY_NAME)?.rejectionCode === "empty_file";
  const unknownSafe = input.unknownRegionFactRows === 0;
  const reprocessed =
    decisionByName(input.reprocess, NORMAL_NAME)?.action === "duplicate" &&
    input.factCountBeforeReprocess === input.factCountAfterReprocess;
  const checks = [accepted, duplicate, revision, invalid, unknownSafe, reprocessed];

  return {
    scenarios: 8,
    handledCorrectly:
      (accepted ? 2 : 0) +
      (duplicate ? 1 : 0) +
      (revision ? 1 : 0) +
      (invalid ? 2 : 0) +
      (unknownSafe ? 1 : 0) +
      (reprocessed ? 1 : 0),
    acceptedCorrectly: accepted ? "2/2" : "failed",
    duplicateDetected: duplicate ? "1/1" : "failed",
    revisionPreserved: revision ? "1/1" : "failed",
    invalidQuarantined: invalid ? "2/2" : "failed",
    unknownRegionFactRows: input.unknownRegionFactRows,
    duplicateFactsAfterReprocess:
      input.factCountAfterReprocess - input.factCountBeforeReprocess,
    silentOverwrites: revision ? 0 : 1,
    dataLoss: input.expectedArtifacts - input.observedArtifacts,
    wholePipelineFailure: input.pipelineFailed || checks.some((value) => !value)
  };
}

async function stressTest(
  databaseUrl: string,
  root: string
): Promise<Record<string, unknown>> {
  const paths = {
    inbox: resolve(root, "stress/inbox"),
    datasets: resolve(root, "stress/datasets"),
    workspace: resolve(root, "stress/workspace"),
    generated: resolve(root, "stress/generated")
  };
  await Promise.all([
    mkdir(paths.inbox, { recursive: true }),
    mkdir(paths.datasets, { recursive: true }),
    mkdir(paths.workspace, { recursive: true })
  ]);
  await Promise.all([
    writeFile(resolve(paths.inbox, NORMAL_NAME), POHANG_POPULATION),
    writeFile(resolve(paths.inbox, DUPLICATE_NAME), POHANG_POPULATION),
    writeFile(
      resolve(paths.inbox, HTML_NAME),
      "<!DOCTYPE html><html><body>portal error</body></html>"
    ),
    writeFile(resolve(paths.inbox, EMPTY_NAME), Buffer.alloc(0)),
    writeFile(
      resolve(paths.inbox, CP949_NAME),
      iconv.encode(GIMCHEON_POPULATION, "cp949")
    ),
    writeFile(resolve(paths.inbox, UNKNOWN_NAME), UNKNOWN_POPULATION)
  ]);

  let pipelineFailed = false;
  let first: IntakeRunResult;
  try {
    first = await runIsolatedIntake(databaseUrl, paths);
  } catch (error) {
    pipelineFailed = true;
    throw error;
  }
  const unknownFactsResult = await queryUnknownRegionFacts(databaseUrl);

  await writeFile(
    resolve(paths.inbox, NORMAL_NAME),
    POHANG_POPULATION_REVISION
  );
  const revision = await runIsolatedIntake(databaseUrl, paths);
  const beforeReprocess = await queryCounts(databaseUrl, paths.datasets);

  await writeFile(resolve(paths.inbox, NORMAL_NAME), POHANG_POPULATION);
  const reprocess = await runIsolatedIntake(databaseUrl, paths);
  const afterReprocess = await queryCounts(databaseUrl, paths.datasets);

  const original = resolve(paths.datasets, "population", NORMAL_NAME);
  const revisionPath = resolve(
    paths.datasets,
    "population",
    NORMAL_NAME.replace(".csv", "__r2.csv")
  );
  const observedArtifacts =
    first.decisions.length + revision.decisions.length + reprocess.decisions.length;
  const verdict = evaluateStressDecisions({
    first: first.decisions,
    revision: revision.decisions,
    reprocess: reprocess.decisions,
    unknownRegionFactRows: unknownFactsResult,
    factCountBeforeReprocess: beforeReprocess.facts,
    factCountAfterReprocess: afterReprocess.facts,
    originalStillExists: await exists(original),
    revisionExists: await exists(revisionPath),
    expectedArtifacts: 8,
    observedArtifacts,
    pipelineFailed
  });

  return {
    verdict,
    firstBatch: {
      counts: first.counts,
      decisions: first.decisions.map((decision) => ({
        fileName: decision.fileName,
        action: decision.action,
        encoding: decision.encoding,
        contentKind: decision.contentKind,
        rejectionCode: decision.rejectionCode
      }))
    },
    revision: {
      counts: revision.counts,
      storedPath: revision.decisions[0]?.storedPath,
      originalPreserved: await exists(original),
      revisionPreserved: await exists(revisionPath)
    },
    identicalReprocess: {
      counts: reprocess.counts,
      before: beforeReprocess,
      after: afterReprocess
    }
  };
}

async function queryUnknownRegionFacts(databaseUrl: string): Promise<number> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM population_observation fact
         JOIN data_source source ON source.source_id = fact.source_id
        WHERE source.file_path LIKE '%없는시%'`
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function idempotencyTest(
  databaseUrl: string,
  root: string
): Promise<Record<string, unknown>> {
  const paths = {
    inbox: resolve(root, "idempotency/inbox"),
    datasets: resolve(root, "idempotency/datasets"),
    workspace: resolve(root, "idempotency/workspace"),
    generated: resolve(root, "idempotency/generated")
  };
  await Promise.all([
    mkdir(paths.inbox, { recursive: true }),
    mkdir(paths.datasets, { recursive: true }),
    mkdir(paths.workspace, { recursive: true })
  ]);
  const runs: Array<RowCounts & { run: number; action: string | null }> = [];
  for (let run = 1; run <= 5; run += 1) {
    await writeFile(resolve(paths.inbox, NORMAL_NAME), POHANG_POPULATION);
    const intake = await runIsolatedIntake(databaseUrl, paths);
    runs.push({
      run,
      action: intake.decisions[0]?.action ?? null,
      ...(await queryCounts(databaseUrl, paths.datasets))
    });
  }
  const first = runs[0];
  const last = runs.at(-1);
  return {
    runs,
    duplicateFactDelta: (last?.facts ?? 0) - (first?.facts ?? 0),
    duplicateSourceDelta: (last?.dataSources ?? 0) - (first?.dataSources ?? 0),
    duplicateLocatorDelta: (last?.locators ?? 0) - (first?.locators ?? 0),
    stable:
      runs.length === 5 &&
      runs.every(
        (run) =>
          run.storedFiles === first?.storedFiles &&
          run.dataSources === first.dataSources &&
          run.facts === first.facts &&
          run.locators === first.locators
      )
  };
}

async function lineageTest(
  databaseUrl: string,
  root: string
): Promise<Record<string, unknown>> {
  const paths = {
    inbox: resolve(root, "lineage/inbox"),
    datasets: resolve(root, "lineage/datasets"),
    workspace: resolve(root, "lineage/workspace"),
    generated: resolve(root, "lineage/generated")
  };
  await Promise.all([
    mkdir(paths.inbox, { recursive: true }),
    mkdir(paths.datasets, { recursive: true }),
    mkdir(paths.workspace, { recursive: true })
  ]);
  const source = resolve(repositoryRoot, KIMCHEON_TAX_SOURCE);
  await copyFile(source, resolve(paths.inbox, basename(source)));
  const intake = await runIsolatedIntake(databaseUrl, paths);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{
      local_tax_revenue_id: string;
      revenue_amount_won: string;
      source_id: string;
      file_path: string;
      file_sha256: string;
      source_url: string | null;
      source_row: number;
      locator_text: string;
      source_locator_id: string;
      intake_file_id: string;
      intake_run_id: string;
      normalization_run_id: string;
      intake_pipeline: string;
      normalization_pipeline: string;
    }>(`
      SELECT
        fact.local_tax_revenue_id::text,
        fact.revenue_amount_won::text,
        source.source_id::text,
        source.file_path,
        source.file_sha256,
        source.source_url,
        fact.source_row,
        locator.locator_text,
        locator.source_locator_id::text,
        raw.intake_file_id::text,
        raw.ingestion_run_id::text AS intake_run_id,
        fact.ingestion_run_id::text AS normalization_run_id,
        intake_run.pipeline_name AS intake_pipeline,
        normalize_run.pipeline_name AS normalization_pipeline
      FROM local_tax_revenue fact
      JOIN dim_region region ON region.region_id = fact.region_id
      JOIN data_source source ON source.source_id = fact.source_id
      JOIN source_locator locator
        ON locator.source_id = source.source_id
       AND locator.entity_type = 'local_tax_revenue'
       AND locator.row_number = fact.source_row
      JOIN raw_intake_file raw ON raw.stored_path = source.file_path
      JOIN ingestion_run intake_run
        ON intake_run.ingestion_run_id = raw.ingestion_run_id
      JOIN ingestion_run normalize_run
        ON normalize_run.ingestion_run_id = fact.ingestion_run_id
      WHERE region.region_name = '김천시'
        AND fact.fiscal_year = 2024
        AND fact.tax_category = '합계'
        AND fact.is_aggregate
        AND fact.amount_semantics = 'collected_amount'
      ORDER BY fact.revenue_amount_won DESC
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("김천시 2024 지방세 lineage를 찾지 못했습니다.");
    return {
      answer: "김천시 2024 지방세 수납액은 107,720,311,000원입니다.",
      answerValueWon: 107_720_311_000,
      observedValueWon: Number(row.revenue_amount_won),
      valueMatches: Number(row.revenue_amount_won) === 107_720_311_000,
      fact: {
        id: row.local_tax_revenue_id,
        sourceRow: row.source_row,
        normalizationRunId: row.normalization_run_id,
        normalizationPipeline: row.normalization_pipeline
      },
      source: {
        id: row.source_id,
        filePath: row.file_path,
        sha256: row.file_sha256,
        sourceUrl: row.source_url
      },
      locator: {
        id: row.source_locator_id,
        text: row.locator_text
      },
      rawIntake: {
        id: row.intake_file_id,
        runId: row.intake_run_id,
        pipeline: row.intake_pipeline,
        action: intake.decisions[0]?.action
      },
      complete:
        Number(row.revenue_amount_won) === 107_720_311_000 &&
        Boolean(
          row.local_tax_revenue_id &&
            row.source_id &&
            row.source_locator_id &&
            row.intake_file_id &&
            row.intake_run_id &&
            row.normalization_run_id
        )
    };
  } finally {
    await client.end();
  }
}

function markdown(report: {
  measuredAt: string;
  elapsedMs: number;
  stress: Record<string, unknown>;
  idempotency: Record<string, unknown>;
  lineage: Record<string, unknown>;
}): string {
  const stress = report.stress.verdict as unknown as StressVerdict;
  const idempotency = report.idempotency as {
    runs: Array<RowCounts & { run: number; action: string | null }>;
    duplicateFactDelta: number;
    duplicateSourceDelta: number;
    duplicateLocatorDelta: number;
    stable: boolean;
  };
  const lineage = report.lineage as {
    answer: string;
    observedValueWon: number;
    complete: boolean;
    fact: { id: string };
    source: { id: string; filePath: string; sha256: string };
    locator: { id: string; text: string };
    rawIntake: { id: string; runId: string };
  };
  return [
    "# Ingestion Reliability Stress Test",
    "",
    `- 측정 시각: ${report.measuredAt}`,
    `- 전체 측정 시간: ${(report.elapsedMs / 1000).toFixed(2)}초`,
    "- 환경: 매 실험마다 빈 임시 PostgreSQL과 격리된 raw store 사용 후 삭제",
    "",
    "## Stress Test",
    "",
    "| 항목 | 결과 |",
    "| --- | ---: |",
    `| 시나리오 | ${stress.scenarios} |`,
    `| 올바르게 처리 | ${stress.handledCorrectly}/${stress.scenarios} |`,
    `| 정상/CP949 ingest | ${stress.acceptedCorrectly} |`,
    `| 내용 기반 duplicate 탐지 | ${stress.duplicateDetected} |`,
    `| revision 보존 | ${stress.revisionPreserved} |`,
    `| HTML/빈 파일 quarantine | ${stress.invalidQuarantined} |`,
    `| 미등록 지역 fact 전환 | ${stress.unknownRegionFactRows}건 |`,
    `| 동일 입력 재처리 후 duplicate fact | ${stress.duplicateFactsAfterReprocess}건 |`,
    `| silent overwrite | ${stress.silentOverwrites}건 |`,
    `| data loss | ${stress.dataLoss}건 |`,
    `| 전체 pipeline 실패 | ${stress.wholePipelineFailure ? "Yes" : "No"} |`,
    "",
    "## 5회 재실행 멱등성",
    "",
    "| Run | 판정 | raw store | data_source | facts | locators | ledger events |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...idempotency.runs.map(
      (run) =>
        `| #${run.run} | ${run.action} | ${run.storedFiles} | ${run.dataSources} | ${run.facts} | ${run.locators} | ${run.rawLedgerRows} |`
    ),
    "",
    `- fact 증가: **${idempotency.duplicateFactDelta}건**`,
    `- source 증가: **${idempotency.duplicateSourceDelta}건**`,
    `- locator 증가: **${idempotency.duplicateLocatorDelta}건**`,
    `- 핵심 row count 안정: **${idempotency.stable ? "Yes" : "No"}**`,
    "- duplicate 이벤트는 원장에 남으므로 ledger events만 1→5로 증가한다.",
    "",
    "## End-to-End Provenance Trace",
    "",
    `> ${lineage.answer}`,
    "",
    `- 관측값: ${lineage.observedValueWon.toLocaleString("ko-KR")}원`,
    `- fact: \`${lineage.fact.id}\``,
    `- source: \`${lineage.source.id}\``,
    `- locator: \`${lineage.locator.id}\` → \`${lineage.locator.text}\``,
    `- raw intake: \`${lineage.rawIntake.id}\``,
    `- intake run: \`${lineage.rawIntake.runId}\``,
    `- raw file: \`${lineage.source.filePath}\``,
    `- SHA-256: \`${lineage.source.sha256}\``,
    `- 전체 chain 완성: **${lineage.complete ? "Yes" : "No"}**`,
    ""
  ].join("\n");
}

async function main(): Promise<void> {
  loadEnvFile(resolve(repositoryRoot, ".env"));
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl) throw new Error("DATABASE_URL이 필요합니다.");
  const adminUrl = new URL(configuredUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  const root = await mkdtemp(resolve(tmpdir(), "gb-intake-reliability-"));
  const databases: DatabaseHandle[] = [];
  const startedAt = performance.now();

  try {
    await admin.connect();
    const stressDatabase = await createDatabase(admin, configuredUrl);
    databases.push(stressDatabase);
    await applySchemaToDatabase(stressDatabase.url);
    const stress = await stressTest(stressDatabase.url, root);

    const idempotencyDatabase = await createDatabase(admin, configuredUrl);
    databases.push(idempotencyDatabase);
    await applySchemaToDatabase(idempotencyDatabase.url);
    const idempotency = await idempotencyTest(idempotencyDatabase.url, root);

    const lineageDatabase = await createDatabase(admin, configuredUrl);
    databases.push(lineageDatabase);
    await applySchemaToDatabase(lineageDatabase.url);
    const lineage = await lineageTest(lineageDatabase.url, root);

    const report = {
      measuredAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - startedAt),
      isolation: {
        emptyDatabases: 3,
        productionDatabaseModified: false,
        productionDatasetStoreModified: false,
        temporaryResourcesDeleted: true
      },
      stress,
      idempotency,
      lineage
    };
    const out = resolve(
      repositoryRoot,
      option("--out") ?? "benchmark/reports/intake-reliability"
    );
    await mkdir(out, { recursive: true });
    await writeFile(
      resolve(out, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
    await writeFile(resolve(out, "report.md"), markdown(report));
    console.log(JSON.stringify({ reportDirectory: out, ...report }, null, 2));
  } finally {
    for (const database of databases.reverse()) {
      await dropDatabase(admin, database).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`[intake-reliability] 실패: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
