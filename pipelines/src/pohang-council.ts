import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const POHANG_BILL_SEARCH_URL =
  "https://council.pohang.go.kr/content/activity/billSearch.html";
export const POHANG_ROBOTS_URL = "https://council.pohang.go.kr/robots.txt";
const CRAWLER_USER_AGENT =
  "gyeongbuk-public-ai-pohang-council-crawler/1.0";

export interface PohangBillListItem {
  sourceRecordId: number;
  billNumber: string;
  title: string;
  proposer: string;
  sessionNumber: number | null;
  receiptDate: string | null;
  detailUrl: string;
}

export interface PohangBillAttachment {
  name: string;
  url: string;
  sourceAttachmentId: number | null;
}

export interface PohangDateQualityIssue {
  field: string;
  rawValue: string;
  normalizedValue: string | null;
  issueCode:
    | "source_year_transposition"
    | "source_date_delimiter_normalized"
    | "missing_date_sentinel"
    | "invalid_source_date";
}

export interface PohangBill extends PohangBillListItem {
  councilName: "포항시의회";
  regionName: "포항시";
  sharedMembers: string | null;
  sessionName: string | null;
  proposalDate: string | null;
  transferDate: string | null;
  committeeName: string | null;
  committeeReferralDate: string | null;
  committeePresentedDate: string | null;
  committeeDecisionDate: string | null;
  committeeResult: string | null;
  plenaryPresentedDate: string | null;
  plenaryDecisionDate: string | null;
  plenaryResult: string | null;
  attachments: PohangBillAttachment[];
  dataQualityIssues: PohangDateQualityIssue[];
}

export interface PohangListPage {
  totalRecords: number;
  currentPage: number;
  totalPages: number;
  bills: PohangBillListItem[];
}

export interface CrawlOptions {
  outputDirectory: string;
  concurrency?: number;
  retries?: number;
  requestDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onProgress?: (message: string) => void;
  termsAcknowledged?: boolean;
  allowUnavailableRobots?: boolean;
}

const normalizedText = (value: string): string =>
  decodeHtml(value.replace(/<br\s*\/?>/giu, " ").replace(/<[^>]*>/gu, " "))
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();

export function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&#(\d+);/gu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10))
    )
    .replace(/&([a-z]+);/giu, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function validIsoDate(value: string, maximumYear: number): string | null {
  const delimiterNormalized = /^\d{4}\.\d{2}\.\d{2}\.?$/u.test(value)
    ? value.replace(/\./gu, "-").replace(/-$/u, "")
    : value;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(delimiterNormalized)) return null;
  const candidate = /^02\d{2}-/u.test(delimiterNormalized)
    ? `20${delimiterNormalized.slice(2)}`
    : delimiterNormalized;
  const year = Number(candidate.slice(0, 4));
  if (year < 1990 || year > maximumYear) return null;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function absoluteUrl(href: string): string {
  return new URL(decodeHtml(href), POHANG_BILL_SEARCH_URL).toString();
}

function classCell(row: string, className: string): string {
  const match = row.match(
    new RegExp(`<td[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "iu")
  );
  return normalizedText(match?.[1] ?? "");
}

export function parsePohangListPage(
  html: string,
  maximumYear = new Date().getUTCFullYear() + 1
): PohangListPage {
  const pageMatch = html.match(
    /전체\s*<strong[^>]*class=["']num1["'][^>]*>\s*([\d,]+)\s*<\/strong>[\s\S]*?<strong[^>]*class=["']num2["'][^>]*>\s*(\d+)\s*<\/strong>\s*\/\s*<strong[^>]*class=["']num3["'][^>]*>\s*(\d+)\s*<\/strong>/iu
  );
  if (!pageMatch) throw new Error("Pohang bill pagination metadata was not found");

  const board = html.match(/<div[^>]*class=["'][^"']*\bboard_body\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu)?.[1];
  if (!board) throw new Error("Pohang bill list table was not found");

  const bills: PohangBillListItem[] = [];
  for (const rowMatch of board.matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/giu)) {
    const row = rowMatch[1] ?? "";
    const link = row.match(
      /<td[^>]*class=["'][^"']*\bbill_billname\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']*\bnumber=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/iu
    );
    if (!link) continue;
    const sessionText = classCell(row, "bill_session");
    bills.push({
      sourceRecordId: Number(link[2]),
      billNumber: classCell(row, "bill_billnumber").replace(/\s+/gu, ""),
      title: normalizedText(link[3] ?? ""),
      proposer: classCell(row, "bill_proposer"),
      sessionNumber: /^\d+$/u.test(sessionText) ? Number(sessionText) : null,
      receiptDate: validIsoDate(classCell(row, "bill_date"), maximumYear),
      detailUrl: absoluteUrl(link[1] ?? "")
    });
  }
  if (bills.length === 0) throw new Error("Pohang bill list contains no records");

  return {
    totalRecords: Number((pageMatch[1] ?? "").replace(/,/gu, "")),
    currentPage: Number(pageMatch[2]),
    totalPages: Number(pageMatch[3]),
    bills
  };
}

interface DetailFields {
  base: Map<string, string>;
  committee: Map<string, string>;
  plenary: Map<string, string>;
}

function detailFields(table: string): DetailFields {
  const result: DetailFields = {
    base: new Map(),
    committee: new Map(),
    plenary: new Map()
  };
  let section: keyof DetailFields = "base";
  for (const rowMatch of table.matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/giu)) {
    const row = rowMatch[1] ?? "";
    const heading = row.match(/<th([^>]*)>([\s\S]*?)<\/th>/iu);
    if (!heading) continue;
    const label = normalizedText(heading[2] ?? "");
    if (/\bcolspan\s*=\s*["']?2/iu.test(heading[1] ?? "")) {
      if (label === "위원회") section = "committee";
      if (label === "본회의") section = "plenary";
      continue;
    }
    const cell = row.match(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/iu);
    if (cell) result[section].set(label, normalizedText(cell[1] ?? ""));
  }
  return result;
}

const nullable = (value: string | undefined): string | null => value || null;
function dateField(
  field: string,
  value: string | undefined,
  issues: PohangDateQualityIssue[],
  maximumYear: number
): string | null {
  if (!value) return null;
  const normalizedValue = validIsoDate(value, maximumYear);
  if (normalizedValue !== value) {
    const issueCode = value === "0000-00-00"
      ? "missing_date_sentinel"
      : normalizedValue && value.includes(".")
        ? "source_date_delimiter_normalized"
        : normalizedValue
          ? "source_year_transposition"
          : "invalid_source_date";
    issues.push({
      field,
      rawValue: value,
      normalizedValue,
      issueCode
    });
  }
  return normalizedValue;
}

export function parsePohangBillDetail(
  html: string,
  listItem: PohangBillListItem,
  maximumYear = new Date().getUTCFullYear() + 1
): PohangBill {
  const viewer = html.match(/<div[^>]*class=["'][^"']*\bpcViewer\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu)?.[1];
  const table = viewer?.match(/<table[^>]*class=["'][^"']*\btable_bill\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/iu)?.[1];
  if (!table) throw new Error(`Pohang bill detail table was not found: ${listItem.sourceRecordId}`);
  const fields = detailFields(table);
  const dataQualityIssues: PohangDateQualityIssue[] = [];

  const attachments: PohangBillAttachment[] = [];
  for (const match of table.matchAll(/<a[^>]*href=["']([^"']*bill_download\.html\?number=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/giu)) {
    attachments.push({
      name: normalizedText(match[3] ?? ""),
      url: absoluteUrl(match[1] ?? ""),
      sourceAttachmentId: Number(match[2])
    });
  }

  const title = fields.base.get("의안명") ?? listItem.title;
  const billNumber = fields.base.get("의안번호")?.replace(/\s+/gu, "") ?? listItem.billNumber;
  if (!title || !billNumber) {
    throw new Error(`Required detail fields are missing: ${listItem.sourceRecordId}`);
  }
  return {
    ...listItem,
    title,
    billNumber,
    proposer: fields.base.get("발의자") ?? listItem.proposer,
    councilName: "포항시의회",
    regionName: "포항시",
    sharedMembers: nullable(fields.base.get("공유된 의원")),
    sessionName: nullable(fields.base.get("회기")),
    proposalDate: dateField(
      "proposalDate",
      fields.base.get("발의일"),
      dataQualityIssues,
      maximumYear
    ),
    transferDate: dateField(
      "transferDate",
      fields.base.get("이송일"),
      dataQualityIssues,
      maximumYear
    ),
    committeeName: nullable(fields.committee.get("소관위원회")),
    committeeReferralDate: dateField("committeeReferralDate", fields.committee.get("회부일"), dataQualityIssues, maximumYear),
    committeePresentedDate: dateField("committeePresentedDate", fields.committee.get("상정일"), dataQualityIssues, maximumYear),
    committeeDecisionDate: dateField("committeeDecisionDate", fields.committee.get("처리일"), dataQualityIssues, maximumYear),
    committeeResult: nullable(fields.committee.get("결과")),
    plenaryPresentedDate: dateField("plenaryPresentedDate", fields.plenary.get("상정일"), dataQualityIssues, maximumYear),
    plenaryDecisionDate: dateField("plenaryDecisionDate", fields.plenary.get("처리일"), dataQualityIssues, maximumYear),
    plenaryResult: nullable(fields.plenary.get("결과")),
    attachments,
    dataQualityIssues
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function pohangBillsToCsv(bills: PohangBill[]): string {
  const headers = [
    "의안번호", "의안명", "발의자", "회기", "접수일", "발의일자", "이송일",
    "소관위원회", "위원회회부일", "위원회상정일", "위원회처리일", "위원회처리결과",
    "본회의상정일", "본회의처리일", "본회의처리결과", "첨부파일명", "첨부파일URL",
    "원문URL", "원문레코드ID", "데이터품질이슈"
  ];
  const rows = bills.map((bill) => [
    bill.billNumber, bill.title, bill.proposer, bill.sessionName, bill.receiptDate,
    bill.proposalDate, bill.transferDate, bill.committeeName, bill.committeeReferralDate,
    bill.committeePresentedDate, bill.committeeDecisionDate, bill.committeeResult,
    bill.plenaryPresentedDate, bill.plenaryDecisionDate, bill.plenaryResult,
    bill.attachments.map((item) => item.name).join(" | "),
    bill.attachments.map((item) => item.url).join(" | "), bill.detailUrl,
    bill.sourceRecordId, JSON.stringify(bill.dataQualityIssues)
  ]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, path);
}

export function robotsAllowsPath(
  contents: string,
  path: string,
  userAgent = CRAWLER_USER_AGENT
): boolean | null {
  const groups: Array<{
    agents: string[];
    rules: Array<{ allow: boolean; path: string }>;
  }> = [];
  let current:
    | {
        agents: string[];
        rules: Array<{ allow: boolean; path: string }>;
      }
    | null = null;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (
      current &&
      (field === "allow" || field === "disallow")
    ) {
      current.rules.push({ allow: field === "allow", path: value });
    }
  }
  if (groups.length === 0) return null;
  const normalizedAgent = userAgent.toLowerCase();
  const matching = groups.filter((group) =>
    group.agents.some(
      (agent) => agent === "*" || normalizedAgent.includes(agent)
    )
  );
  if (matching.length === 0) return true;
  const rules = matching
    .flatMap((group) => group.rules)
    .filter((rule) => rule.path && path.startsWith(rule.path))
    .sort(
      (left, right) =>
        right.path.length - left.path.length ||
        Number(right.allow) - Number(left.allow)
    );
  return rules[0]?.allow ?? true;
}

function createRequestGate(intervalMs: number): () => Promise<void> {
  let previous = Promise.resolve();
  let lastStartedAt = 0;
  return async () => {
    const turn = previous.then(async () => {
      const waitMs = Math.max(0, lastStartedAt + intervalMs - Date.now());
      if (waitMs > 0) {
        await new Promise((done) => setTimeout(done, waitMs));
      }
      lastStartedAt = Date.now();
    });
    previous = turn.catch(() => undefined);
    await turn;
  };
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
  retries: number,
  delayMs: number,
  waitForRequest: () => Promise<void>
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await waitForRequest();
      const response = await fetchImpl(url, {
        headers: { "user-agent": CRAWLER_USER_AGENT },
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((done) => setTimeout(done, delayMs * 2 ** attempt));
    }
  }
  throw new Error(`Failed to fetch ${url}: ${String(lastError)}`);
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await mapper(values[index] as T, index);
      }
    })
  );
  return output;
}

export async function crawlPohangBills(options: CrawlOptions): Promise<{
  bills: PohangBill[];
  metadataPath: string;
  jsonPath: string;
  csvPath: string;
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = options.concurrency ?? 2;
  const retries = options.retries ?? 3;
  const delayMs = options.requestDelayMs ?? 500;
  const progress = options.onProgress ?? (() => undefined);
  const retrievedAt = (options.now ?? (() => new Date()))();
  const maximumYear = retrievedAt.getUTCFullYear() + 1;
  if (!options.termsAcknowledged) {
    throw new Error(
      "The operator must pass termsAcknowledged after reviewing the public site's terms and crawl policy"
    );
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("Concurrency must be an integer between 1 and 4");
  }
  if (!Number.isFinite(delayMs) || delayMs < 250) {
    throw new Error("requestDelayMs must be at least 250 milliseconds");
  }
  const waitForRequest = createRequestGate(delayMs);
  let robotsStatus: "allowed" | "acknowledged_unavailable";
  try {
    const robots = await fetchText(
      POHANG_ROBOTS_URL,
      fetchImpl,
      retries,
      delayMs,
      waitForRequest
    );
    const allowed = robotsAllowsPath(
      robots,
      new URL(POHANG_BILL_SEARCH_URL).pathname
    );
    if (allowed === false) {
      throw new Error("robots.txt disallows the Pohang bill search path");
    }
    if (allowed === null) {
      if (!options.allowUnavailableRobots) {
        throw new Error(
          "robots.txt could not be interpreted; explicit operator acknowledgement is required"
        );
      }
      robotsStatus = "acknowledged_unavailable";
    } else {
      robotsStatus = "allowed";
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("disallows")
    ) {
      throw error;
    }
    if (!options.allowUnavailableRobots) throw error;
    robotsStatus = "acknowledged_unavailable";
  }

  const firstPage = parsePohangListPage(
    await fetchText(
      `${POHANG_BILL_SEARCH_URL}?page=1`,
      fetchImpl,
      retries,
      delayMs,
      waitForRequest
    ),
    maximumYear
  );
  progress(`목록 1/${firstPage.totalPages} (${firstPage.bills.length}건)`);
  const remainingPages = Array.from({ length: firstPage.totalPages - 1 }, (_, index) => index + 2);
  const pages = await mapConcurrent(remainingPages, concurrency, async (page, index) => {
    const parsed = parsePohangListPage(
      await fetchText(
        `${POHANG_BILL_SEARCH_URL}?page=${page}`,
        fetchImpl,
        retries,
        delayMs,
        waitForRequest
      ),
      maximumYear
    );
    if ((index + 1) % 25 === 0 || page === firstPage.totalPages) {
      progress(`목록 ${page}/${firstPage.totalPages}`);
    }
    return parsed;
  });
  const listItems = [firstPage, ...pages].flatMap((page) => page.bills);
  const unique = new Map(listItems.map((bill) => [bill.sourceRecordId, bill]));
  if (unique.size !== firstPage.totalRecords) {
    throw new Error(
      `List integrity failure: expected ${firstPage.totalRecords}, found ${unique.size} unique records`
    );
  }

  let completed = 0;
  const bills = await mapConcurrent([...unique.values()], concurrency, async (item) => {
    const bill = parsePohangBillDetail(
      await fetchText(
        item.detailUrl,
        fetchImpl,
        retries,
        delayMs,
        waitForRequest
      ),
      item,
      maximumYear
    );
    completed += 1;
    if (completed % 100 === 0 || completed === unique.size) {
      progress(`상세 ${completed}/${unique.size}`);
    }
    return bill;
  });
  bills.sort((left, right) => right.sourceRecordId - left.sourceRecordId);

  const crawledAt = retrievedAt.toISOString();
  const jsonPath = resolve(options.outputDirectory, "pohang_council_bills.json");
  const csvPath = resolve(options.outputDirectory, "경상북도_포항시_의회_의안정보.csv");
  const metadataPath = resolve(options.outputDirectory, "pohang_council_bills.metadata.json");
  const jsonContents = `${JSON.stringify(bills, null, 2)}\n`;
  const csvContents = pohangBillsToCsv(bills);
  await atomicWrite(jsonPath, jsonContents);
  await atomicWrite(csvPath, csvContents);
  const proposalDates = bills
    .map((bill) => bill.proposalDate)
    .filter((value): value is string => value !== null)
    .sort();
  await atomicWrite(
    metadataPath,
    `${JSON.stringify({
      sourceUrl: POHANG_BILL_SEARCH_URL,
      retrievedAt: crawledAt,
      crawledAt,
      robots: {
        url: POHANG_ROBOTS_URL,
        status: robotsStatus
      },
      operatorAcknowledgements: {
        publicSiteTermsReviewed: true,
        robotsUnavailableAcknowledged:
          robotsStatus === "acknowledged_unavailable"
      },
      requestPolicy: {
        userAgent: CRAWLER_USER_AGENT,
        minimumIntervalMs: delayMs,
        concurrency
      },
      recordCount: bills.length,
      firstSourceRecordId: bills.at(-1)?.sourceRecordId ?? null,
      lastSourceRecordId: bills[0]?.sourceRecordId ?? null,
      proposalDateCoverage: {
        start: proposalDates[0] ?? null,
        end: proposalDates.at(-1) ?? null
      },
      attachmentCount: bills.reduce((count, bill) => count + bill.attachments.length, 0),
      dataQualityIssueCount: bills.reduce(
        (count, bill) => count + bill.dataQualityIssues.length,
        0
      ),
      sha256: {
        json: createHash("sha256").update(jsonContents).digest("hex"),
        csv: createHash("sha256").update(csvContents).digest("hex")
      },
      outputFiles: ["pohang_council_bills.json", "경상북도_포항시_의회_의안정보.csv"]
    }, null, 2)}\n`
  );
  return { bills, metadataPath, jsonPath, csvPath };
}
