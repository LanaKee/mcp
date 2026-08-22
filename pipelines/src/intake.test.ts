import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildStoreIndex,
  countIntakeActions,
  executeIntake,
  planIntake,
  runIntake,
  storeCategory,
  validateIntakePayload
} from "./intake.js";

let root = "";
let inbox = "";
let datasets = "";
let workspace = "";

const TAX_CSV = [
  "과세년도,시군명,세목명,납부건수,납부금액",
  "2024,포항시,주민세,120,1000",
  "2024,김천시,주민세,90,2000"
].join("\n");

const COUNCIL_CSV = ["의안번호,의안명", "1,지방소멸 대응 조례안"].join("\n");

async function writeInbox(name: string, content: string | Buffer): Promise<void> {
  await mkdir(inbox, { recursive: true });
  await writeFile(resolve(inbox, name), content);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = resolve(
    tmpdir(),
    `intake-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  inbox = resolve(root, "data/intake/inbox");
  datasets = resolve(root, "datasets");
  workspace = resolve(root, "data/intake");
  await mkdir(inbox, { recursive: true });
  await mkdir(datasets, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function intake(options: { dryRun?: boolean } = {}) {
  return runIntake({
    inboxDirectory: inbox,
    datasetDirectory: datasets,
    repositoryRoot: root,
    workspaceDirectory: workspace,
    dryRun: options.dryRun
  });
}

describe("dataset intake", () => {
  it("stores a new file under its routed category and empties the inbox", async () => {
    await writeInbox("경상북도_포항시_지방세 징수현황_20241231.csv", TAX_CSV);

    const result = await intake();

    expect(result.counts).toMatchObject({ accepted: 1, duplicate: 0, quarantined: 0 });
    const decision = result.decisions[0]!;
    expect(decision.action).toBe("accepted");
    expect(decision.storedPath).toBe(
      "datasets/local-tax/경상북도_포항시_지방세 징수현황_20241231.csv"
    );
    expect(decision.referenceDate).toBe("2024-12-31");
    expect(await exists(resolve(root, decision.storedPath!))).toBe(true);
    expect(await readdir(inbox)).toEqual([]);
    expect(result.manifestPath).not.toBeNull();
    const manifest = JSON.parse(
      await readFile(resolve(root, result.manifestPath!), "utf8")
    ) as { counts: { accepted: number } };
    expect(manifest.counts.accepted).toBe(1);
  });

  it("routes files by detected content kind rather than by file name", async () => {
    await writeInbox("council.csv", COUNCIL_CSV);
    const result = await intake();
    expect(result.decisions[0]!.contentKind).toBe("council_agenda");
    expect(result.decisions[0]!.storedPath).toBe("datasets/council/council.csv");
  });

  it("treats byte-identical content as a duplicate and never re-stores it", async () => {
    await writeInbox("tax.csv", TAX_CSV);
    await intake();

    await writeInbox("tax-renamed.csv", TAX_CSV);
    const second = await intake();

    expect(second.counts).toMatchObject({ accepted: 0, duplicate: 1 });
    expect(second.decisions[0]!.duplicateOfPath).toBe("datasets/local-tax/tax.csv");
    expect(second.decisions[0]!.storedPath).toBeNull();
    expect(await exists(resolve(datasets, "local-tax/tax-renamed.csv"))).toBe(false);
    expect(
      await exists(
        resolve(workspace, "duplicates", second.runId, "tax-renamed.csv")
      )
    ).toBe(true);
  });

  it("keeps a changed file with the same name as a separate revision", async () => {
    await writeInbox("tax.csv", TAX_CSV);
    await intake();

    await writeInbox("tax.csv", `${TAX_CSV}\n2024,구미시,주민세,10,3000`);
    const second = await intake();

    expect(second.counts).toMatchObject({ revision: 1, duplicate: 0 });
    expect(second.decisions[0]!.storedPath).toBe("datasets/local-tax/tax__r2.csv");
    expect(await exists(resolve(datasets, "local-tax/tax.csv"))).toBe(true);
    expect(await exists(resolve(datasets, "local-tax/tax__r2.csv"))).toBe(true);
  });

  it("quarantines an HTML error page that was saved with a .csv name", async () => {
    await writeInbox(
      "broken.csv",
      "<!DOCTYPE html>\n<html><body>서비스 점검 중입니다</body></html>"
    );

    const result = await intake();

    expect(result.counts.quarantined).toBe(1);
    expect(result.decisions[0]!.rejectionCode).toBe("html_error_page");
    expect(result.decisions[0]!.storedPath).toBeNull();
    expect(await exists(resolve(datasets, "misc/broken.csv"))).toBe(false);
    const quarantined = resolve(workspace, "quarantine", result.runId, "broken.csv");
    expect(await exists(quarantined)).toBe(true);
    const sidecar = JSON.parse(
      await readFile(`${quarantined}.error.json`, "utf8")
    ) as { rejectionCode: string };
    expect(sidecar.rejectionCode).toBe("html_error_page");
  });

  it("deduplicates two identical files that arrive in the same batch", async () => {
    await writeInbox("a.csv", TAX_CSV);
    await writeInbox("b.csv", TAX_CSV);

    const result = await intake();

    expect(countIntakeActions(result.decisions)).toMatchObject({
      accepted: 1,
      duplicate: 1
    });
  });

  it("makes no filesystem change in dry-run mode", async () => {
    await writeInbox("tax.csv", TAX_CSV);

    const result = await intake({ dryRun: true });

    expect(result.mode).toBe("dry-run");
    expect(result.counts.accepted).toBe(1);
    expect(result.manifestPath).toBeNull();
    expect(await readdir(inbox)).toEqual(["tax.csv"]);
    expect(await exists(resolve(datasets, "local-tax/tax.csv"))).toBe(false);
  });

  it("is a no-op when the inbox is empty or missing", async () => {
    await rm(inbox, { recursive: true, force: true });
    const result = await intake();
    expect(result.decisions).toEqual([]);
    expect(result.counts).toMatchObject({
      accepted: 0,
      revision: 0,
      duplicate: 0,
      quarantined: 0
    });
  });

  it("releases its lock so consecutive runs succeed", async () => {
    await writeInbox("tax.csv", TAX_CSV);
    await intake();
    await writeInbox("council.csv", COUNCIL_CSV);
    await expect(intake()).resolves.toMatchObject({ counts: { accepted: 1 } });
  });

  it("refuses to run while another intake holds the lock", async () => {
    await mkdir(workspace, { recursive: true });
    await writeFile(resolve(workspace, "intake.lock"), "{}\n");
    await expect(intake()).rejects.toThrow(/holds/);
  });

  it("reuses cached hashes only while size and mtime agree", async () => {
    const cachePath = resolve(root, "data/generated/intake-store-index.json");
    await mkdir(resolve(datasets, "local-tax"), { recursive: true });
    const stored = resolve(datasets, "local-tax/tax.csv");
    await writeFile(stored, TAX_CSV);

    const first = await buildStoreIndex(datasets, root, { cachePath });
    expect([...first.byHash.values()]).toEqual(["datasets/local-tax/tax.csv"]);

    await writeFile(stored, `${TAX_CSV}\n2024,영주시,주민세,5,10`);
    const second = await buildStoreIndex(datasets, root, { cachePath });
    expect([...second.byHash.keys()]).not.toEqual([...first.byHash.keys()]);
  });
});

describe("intake payload validation", () => {
  it("accepts a well-formed Korean CSV", () => {
    expect(validateIntakePayload(Buffer.from(TAX_CSV, "utf8"), "tax.csv")).toBeNull();
  });

  it("rejects unsupported extensions", () => {
    expect(
      validateIntakePayload(Buffer.from("x"), "notes.txt")
    ).toMatchObject({ code: "unsupported_extension" });
  });

  it("rejects an empty file", () => {
    expect(validateIntakePayload(Buffer.alloc(0), "tax.csv")).toMatchObject({
      code: "empty_file"
    });
  });

  it("rejects a file past the size limit", () => {
    expect(
      validateIntakePayload(Buffer.from(TAX_CSV), "tax.csv", { maxBytes: 4 })
    ).toMatchObject({ code: "file_too_large" });
  });

  it("rejects a PDF whose bytes are not a PDF", () => {
    expect(
      validateIntakePayload(Buffer.from("not really a pdf"), "report.pdf")
    ).toMatchObject({ code: "signature_mismatch" });
  });

  it("rejects an xlsx that is not a ZIP container", () => {
    expect(
      validateIntakePayload(Buffer.from("plain text"), "book.xlsx")
    ).toMatchObject({ code: "signature_mismatch" });
  });

  it("rejects a CSV that has headers but no data rows", () => {
    expect(
      validateIntakePayload(Buffer.from("과세년도,시군명,세목명,납부건수,납부금액", "utf8"), "tax.csv")
    ).toMatchObject({ code: "no_data_rows" });
  });

  it("rejects malformed JSON", () => {
    expect(
      validateIntakePayload(Buffer.from("{ not json", "utf8"), "records.json")
    ).toMatchObject({ code: "unparsable_content" });
  });

  it("accepts a valid PDF header", () => {
    expect(
      validateIntakePayload(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"), "plan.pdf")
    ).toBeNull();
  });
});

describe("store routing", () => {
  it("sends each content kind to a stable directory", () => {
    expect(storeCategory("local_tax_collection", ".csv")).toBe("local-tax");
    expect(storeCategory("property_valuation_microdata", ".csv")).toBe("local-tax");
    expect(storeCategory("local_tax_yearbook", ".hwpx")).toBe("local-tax");
    expect(storeCategory("population_annual", ".csv")).toBe("population");
    expect(storeCategory("population_workbook", ".xlsx")).toBe("population");
    expect(storeCategory("council_agenda", ".csv")).toBe("council");
    expect(storeCategory("press_release", ".csv")).toBe("press-release");
    expect(storeCategory("pdf_document", ".pdf")).toBe("documents");
    expect(storeCategory("other", ".xml")).toBe("misc");
  });
});

describe("intake planning", () => {
  it("never reserves a path that the store already holds", async () => {
    await mkdir(resolve(datasets, "local-tax"), { recursive: true });
    await writeFile(resolve(datasets, "local-tax/tax.csv"), TAX_CSV);
    await writeInbox("tax.csv", `${TAX_CSV}\n2024,울진군,주민세,7,70`);

    const storeIndex = await buildStoreIndex(datasets, root);
    const plan = await planIntake({
      inboxDirectory: inbox,
      repositoryRoot: root,
      storeIndex
    });

    expect(plan.decisions[0]!.storedPath).toBe("datasets/local-tax/tax__r2.csv");
    expect(storeIndex.paths.has(plan.decisions[0]!.storedPath!)).toBe(false);
  });

  it("refuses to overwrite a store file that appeared after planning", async () => {
    await writeInbox("tax.csv", TAX_CSV);
    const storeIndex = await buildStoreIndex(datasets, root);
    const plan = await planIntake({
      inboxDirectory: inbox,
      repositoryRoot: root,
      storeIndex
    });

    await mkdir(resolve(datasets, "local-tax"), { recursive: true });
    await writeFile(resolve(datasets, "local-tax/tax.csv"), "raced\n");

    await expect(
      executeIntake(plan, { repositoryRoot: root, workspaceDirectory: workspace })
    ).rejects.toThrow(/Refusing to overwrite/);
    expect(await readFile(resolve(datasets, "local-tax/tax.csv"), "utf8")).toBe("raced\n");
    expect(await readdir(inbox)).toEqual(["tax.csv"]);
  });
});
