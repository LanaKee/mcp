import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  describeDatasetFile,
  MEDIA_TYPES,
  type DatasetContentKind
} from "./catalog.js";
import { decodeKoreanCsv, parseKoreanCsv } from "./csv.js";

export const INTAKE_PIPELINE_NAME = "dataset-intake";
export const INTAKE_PIPELINE_VERSION = "intake-v1";

/** Raw formats the store accepts. Anything else is quarantined for human review. */
export const ACCEPTED_EXTENSIONS = [
  ".csv",
  ".xlsx",
  ".hwpx",
  ".pdf",
  ".json",
  ".xml"
] as const;

export const DEFAULT_MAX_INTAKE_BYTES = 512 * 1024 * 1024;

export type IntakeAction = "accepted" | "revision" | "duplicate" | "quarantined";

export type IntakeRejectionCode =
  | "unsupported_extension"
  | "empty_file"
  | "file_too_large"
  | "signature_mismatch"
  | "html_error_page"
  | "undecodable_text"
  | "unparsable_content"
  | "no_data_rows";

export interface IntakeDecision {
  fileName: string;
  inboxPath: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
  contentKind: DatasetContentKind | "unknown";
  encoding: string | null;
  referenceDate: string | null;
  action: IntakeAction;
  storedPath: string | null;
  duplicateOfPath: string | null;
  rejectionCode: IntakeRejectionCode | null;
  rejectionMessage: string | null;
}

export interface IntakePlan {
  inboxDirectory: string;
  decisions: IntakeDecision[];
}

export interface StoreIndex {
  byHash: Map<string, string>;
  paths: Set<string>;
}

export interface IntakeCounts {
  accepted: number;
  revision: number;
  duplicate: number;
  quarantined: number;
}

export interface IntakeRunResult {
  runId: string;
  pipelineName: string;
  pipelineVersion: string;
  mode: "write" | "dry-run";
  startedAt: string;
  finishedAt: string;
  inboxDirectory: string;
  counts: IntakeCounts;
  decisions: IntakeDecision[];
  manifestPath: string | null;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function walkFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return walkFiles(path);
        return entry.isFile() ? [path] : [];
      })
  );
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

interface StoreIndexCacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

/**
 * Content-addressed view of the immutable raw store. Hashes are cached by
 * path/size/mtime so repeated intake runs do not re-read the whole corpus.
 */
export async function buildStoreIndex(
  datasetDirectory: string,
  repositoryRoot: string,
  options: { cachePath?: string } = {}
): Promise<StoreIndex> {
  const cache = new Map<string, StoreIndexCacheEntry>();
  if (options.cachePath) {
    try {
      const parsed = JSON.parse(
        await readFile(options.cachePath, "utf8")
      ) as StoreIndexCacheEntry[];
      for (const entry of parsed) cache.set(entry.path, entry);
    } catch {
      // A missing or unreadable cache only costs a full rehash.
    }
  }

  const paths = await walkFiles(datasetDirectory);
  const byHash = new Map<string, string>();
  const storePaths = new Set<string>();
  const nextCache: StoreIndexCacheEntry[] = [];

  for (const path of paths) {
    const relativePath = relative(repositoryRoot, path).normalize("NFC");
    const fileStat = await stat(path);
    const cached = cache.get(relativePath);
    const sha256 =
      cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs
        ? cached.sha256
        : await hashFile(path);
    nextCache.push({
      path: relativePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sha256
    });
    storePaths.add(relativePath);
    if (!byHash.has(sha256)) byHash.set(sha256, relativePath);
  }

  if (options.cachePath) {
    await mkdir(dirname(options.cachePath), { recursive: true });
    await writeFile(
      options.cachePath,
      `${JSON.stringify(nextCache, null, 2)}\n`,
      "utf8"
    );
  }
  return { byHash, paths: storePaths };
}

interface Rejection {
  code: IntakeRejectionCode;
  message: string;
}

function startsWithBytes(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, index) => buffer[index] === byte);
}

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];

function looksLikeHtml(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/**
 * Rejects payloads whose bytes contradict their extension. Portal downloads that
 * silently return an HTML error page or a truncated archive are the common case.
 */
export function validateIntakePayload(
  buffer: Buffer,
  fileName: string,
  options: { maxBytes?: number } = {}
): Rejection | null {
  const extension = extname(fileName.normalize("NFC")).toLowerCase();
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    return {
      code: "unsupported_extension",
      message: `Extension ${extension || "(none)"} is not an accepted raw format`
    };
  }
  if (buffer.length === 0) {
    return { code: "empty_file", message: "File is empty" };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_INTAKE_BYTES;
  if (buffer.length > maxBytes) {
    return {
      code: "file_too_large",
      message: `File is ${buffer.length} bytes which exceeds the ${maxBytes} byte limit`
    };
  }

  if (extension === ".pdf" && !startsWithBytes(buffer, PDF_SIGNATURE)) {
    return {
      code: "signature_mismatch",
      message: "PDF payload does not start with %PDF-"
    };
  }
  if (
    (extension === ".xlsx" || extension === ".hwpx") &&
    !startsWithBytes(buffer, ZIP_SIGNATURE)
  ) {
    return {
      code: "signature_mismatch",
      message: `${extension} payload is not a ZIP container`
    };
  }
  if (extension === ".csv" || extension === ".json" || extension === ".xml") {
    if (startsWithBytes(buffer, ZIP_SIGNATURE) || startsWithBytes(buffer, PDF_SIGNATURE)) {
      return {
        code: "signature_mismatch",
        message: `${extension} payload contains binary archive or PDF bytes`
      };
    }
    if (looksLikeHtml(buffer)) {
      return {
        code: "html_error_page",
        message: "Payload is an HTML page rather than the requested dataset"
      };
    }
  }

  if (extension === ".csv") {
    const decoded = decodeKoreanCsv(buffer);
    if (decoded.text.includes("\uFFFD")) {
      return {
        code: "undecodable_text",
        message: "CSV text decoded to replacement characters under both UTF-8 and CP949"
      };
    }
    let parsed;
    try {
      parsed = parseKoreanCsv(buffer);
    } catch (error) {
      return {
        code: "unparsable_content",
        message: error instanceof Error ? error.message : String(error)
      };
    }
    if (parsed.rows.length === 0) {
      return {
        code: "no_data_rows",
        message: "CSV has no data rows, so it cannot produce any fact"
      };
    }
    if (parsed.headers.length === 0) {
      return { code: "unparsable_content", message: "CSV has no header row" };
    }
  }
  if (extension === ".json") {
    try {
      JSON.parse(buffer.toString("utf8"));
    } catch (error) {
      return {
        code: "unparsable_content",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
  if (extension === ".xml") {
    const text = buffer.toString("utf8").trimStart();
    if (!text.startsWith("<")) {
      return { code: "unparsable_content", message: "XML payload does not start with '<'" };
    }
  }
  return null;
}

/** Routes a classified file to its directory inside the immutable raw store. */
export function storeCategory(
  contentKind: DatasetContentKind | "unknown",
  extension: string
): string {
  if (
    contentKind.startsWith("local_tax_") ||
    contentKind === "property_valuation_microdata"
  ) {
    return "local-tax";
  }
  if (contentKind.startsWith("population")) return "population";
  if (
    contentKind === "council_agenda" ||
    contentKind === "council_member" ||
    contentKind === "council_bill" ||
    contentKind === "council_bill_sponsor"
  ) {
    return "council";
  }
  if (contentKind === "press_release") return "press-release";
  if (contentKind === "pdf_document" || extension === ".pdf") return "documents";
  return "misc";
}

function revisionName(fileName: string, revision: number): string {
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${stem}__r${revision}${extension}`;
}

function reserveStorePath(
  fileName: string,
  category: string,
  taken: Set<string>
): { path: string; action: "accepted" | "revision" } {
  const base = `datasets/${category}/${fileName}`.normalize("NFC");
  if (!taken.has(base)) {
    taken.add(base);
    return { path: base, action: "accepted" };
  }
  for (let revision = 2; revision < 1000; revision += 1) {
    const candidate =
      `datasets/${category}/${revisionName(fileName, revision)}`.normalize("NFC");
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return { path: candidate, action: "revision" };
    }
  }
  throw new Error(`Unable to reserve a store path for ${fileName}`);
}

/**
 * Decides what happens to every file currently sitting in the inbox without
 * touching the filesystem, so the plan can be reviewed before it is executed.
 */
export async function planIntake(options: {
  inboxDirectory: string;
  repositoryRoot: string;
  storeIndex: StoreIndex;
  maxBytes?: number;
}): Promise<IntakePlan> {
  const files = await walkFiles(options.inboxDirectory);
  const taken = new Set(options.storeIndex.paths);
  const batchHashes = new Map<string, string>();
  const decisions: IntakeDecision[] = [];

  for (const inboxPath of files) {
    const buffer = await readFile(inboxPath);
    const fileName = (inboxPath.split("/").at(-1) ?? inboxPath).normalize("NFC");
    const sha256 = sha256Hex(buffer);
    const extension = extname(fileName).toLowerCase();
    const rejection = validateIntakePayload(buffer, fileName, {
      maxBytes: options.maxBytes
    });

    if (rejection) {
      decisions.push({
        fileName,
        inboxPath: relative(options.repositoryRoot, inboxPath).normalize("NFC"),
        sha256,
        byteSize: buffer.length,
        mediaType: MEDIA_TYPES[extension] ?? "application/octet-stream",
        contentKind: "unknown",
        encoding: null,
        referenceDate: null,
        action: "quarantined",
        storedPath: null,
        duplicateOfPath: null,
        rejectionCode: rejection.code,
        rejectionMessage: rejection.message
      });
      continue;
    }

    const described = describeDatasetFile(buffer, fileName);
    const existing = options.storeIndex.byHash.get(sha256) ?? batchHashes.get(sha256);
    const base = {
      fileName,
      inboxPath: relative(options.repositoryRoot, inboxPath).normalize("NFC"),
      sha256,
      byteSize: buffer.length,
      mediaType: described.mediaType,
      contentKind: described.contentKind,
      encoding: described.encoding,
      referenceDate: described.referenceDate,
      rejectionCode: null,
      rejectionMessage: null
    };

    if (existing) {
      decisions.push({
        ...base,
        action: "duplicate",
        storedPath: null,
        duplicateOfPath: existing
      });
      continue;
    }

    const reserved = reserveStorePath(
      fileName,
      storeCategory(described.contentKind, described.extension),
      taken
    );
    batchHashes.set(sha256, reserved.path);
    decisions.push({
      ...base,
      action: reserved.action,
      storedPath: reserved.path,
      duplicateOfPath: null
    });
  }

  return { inboxDirectory: options.inboxDirectory, decisions };
}

async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const staging = `${to}.intake-partial`;
  try {
    await rename(from, staging);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, staging);
    await unlink(from);
  }
  let clash = false;
  try {
    await stat(to);
    clash = true;
  } catch {
    // The destination is free, which is what the plan reserved.
  }
  if (clash) {
    await rename(staging, from);
    throw new Error(`Refusing to overwrite an existing store file at ${to}`);
  }
  await rename(staging, to);
}

export function countIntakeActions(decisions: IntakeDecision[]): IntakeCounts {
  return {
    accepted: decisions.filter((decision) => decision.action === "accepted").length,
    revision: decisions.filter((decision) => decision.action === "revision").length,
    duplicate: decisions.filter((decision) => decision.action === "duplicate").length,
    quarantined: decisions.filter((decision) => decision.action === "quarantined").length
  };
}

async function acquireIntakeLock(workspaceDirectory: string): Promise<() => Promise<void>> {
  const lockPath = resolve(workspaceDirectory, "intake.lock");
  await mkdir(workspaceDirectory, { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Another intake run holds ${lockPath}. Remove it only after confirming no run is active.`
      );
    }
    throw error;
  }
  await handle.writeFile(
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
  );
  await handle.close();
  return async () => {
    await rm(lockPath, { force: true });
  };
}

/**
 * Applies a plan: accepted files move into the immutable store, duplicates and
 * rejects move into the intake workspace, and a manifest records every decision.
 */
export async function executeIntake(
  plan: IntakePlan,
  options: {
    repositoryRoot: string;
    workspaceDirectory: string;
    dryRun?: boolean;
    runId?: string;
    now?: () => Date;
  }
): Promise<IntakeRunResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const runId = options.runId ?? randomUUID();
  const dryRun = options.dryRun ?? false;

  if (!dryRun) {
    for (const decision of plan.decisions) {
      const from = resolve(options.repositoryRoot, decision.inboxPath);
      if (decision.action === "accepted" || decision.action === "revision") {
        await moveFile(from, resolve(options.repositoryRoot, decision.storedPath!));
      } else if (decision.action === "duplicate") {
        await moveFile(
          from,
          resolve(options.workspaceDirectory, "duplicates", runId, decision.fileName)
        );
      } else {
        const target = resolve(
          options.workspaceDirectory,
          "quarantine",
          runId,
          decision.fileName
        );
        await moveFile(from, target);
        await writeFile(
          `${target}.error.json`,
          `${JSON.stringify(
            {
              fileName: decision.fileName,
              sha256: decision.sha256,
              byteSize: decision.byteSize,
              rejectionCode: decision.rejectionCode,
              rejectionMessage: decision.rejectionMessage,
              runId,
              quarantinedAt: startedAt
            },
            null,
            2
          )}\n`,
          "utf8"
        );
      }
    }
  }

  const result: IntakeRunResult = {
    runId,
    pipelineName: INTAKE_PIPELINE_NAME,
    pipelineVersion: INTAKE_PIPELINE_VERSION,
    mode: dryRun ? "dry-run" : "write",
    startedAt,
    finishedAt: now().toISOString(),
    inboxDirectory: relative(options.repositoryRoot, plan.inboxDirectory).normalize("NFC"),
    counts: countIntakeActions(plan.decisions),
    decisions: plan.decisions,
    manifestPath: null
  };

  if (!dryRun) {
    const manifestPath = resolve(
      options.workspaceDirectory,
      "manifests",
      `intake-${startedAt.replace(/[:.]/g, "-")}-${runId}.json`
    );
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    result.manifestPath = relative(options.repositoryRoot, manifestPath).normalize("NFC");
  }
  return result;
}

/** Plans and executes one intake run under an exclusive workspace lock. */
export async function runIntake(options: {
  inboxDirectory: string;
  datasetDirectory: string;
  repositoryRoot: string;
  workspaceDirectory: string;
  dryRun?: boolean;
  maxBytes?: number;
  storeIndexCachePath?: string;
  runId?: string;
}): Promise<IntakeRunResult> {
  const release = await acquireIntakeLock(options.workspaceDirectory);
  try {
    const storeIndex = await buildStoreIndex(
      options.datasetDirectory,
      options.repositoryRoot,
      { cachePath: options.storeIndexCachePath }
    );
    const plan = await planIntake({
      inboxDirectory: options.inboxDirectory,
      repositoryRoot: options.repositoryRoot,
      storeIndex,
      maxBytes: options.maxBytes
    });
    return await executeIntake(plan, {
      repositoryRoot: options.repositoryRoot,
      workspaceDirectory: options.workspaceDirectory,
      dryRun: options.dryRun,
      runId: options.runId
    });
  } finally {
    await release();
  }
}
