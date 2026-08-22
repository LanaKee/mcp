import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  atomicWrite,
  createRequestGate,
  decodeHtml,
  fetchText,
  mapConcurrent,
  normalizedBlockText,
  normalizedText,
  robotsAllowsPath
} from "./crawl-http.js";

export const GB_PRESS_BASE_URL = "https://www.gb.go.kr/Main/page.do";
export const GB_PRESS_ROBOTS_URL = "https://www.gb.go.kr/robots.txt";
export const GB_PRESS_LIST_PATH = "/Main/page.do";
export const GB_PRESS_MENU_UID = "6792";
export const GB_PRESS_BOARD_CODE = "bbs_bodo";
export const GB_PRESS_CRAWLER_USER_AGENT =
  "gyeongbuk-public-ai-gb-press-crawler/1.0";
/** The board returns ten rows per page; the offset is a row index, not a page. */
export const GB_PRESS_PAGE_SIZE = 10;

export interface GbPressAttachment {
  name: string;
  url: string;
  order: number | null;
}

export interface GbPressListItem {
  /** `B_STEP`, the board's stable per-post identifier. */
  sourceRecordId: string;
  boardNumber: string;
  viewNumber: string | null;
  title: string;
  department: string | null;
  phone: string | null;
  /** Expanded from the list's two-digit year; the detail page is authoritative. */
  listedDate: string | null;
  excerpt: string | null;
  detailUrl: string;
}

export type GbPressQualityIssueCode =
  | "ambiguous_two_digit_year"
  | "missing_published_date"
  | "invalid_published_date"
  | "empty_body"
  | "title_mismatch";

export interface GbPressQualityIssue {
  field: string;
  rawValue: string;
  normalizedValue: string | null;
  issueCode: GbPressQualityIssueCode;
}

export interface GbPressRelease extends GbPressListItem {
  provinceName: "경상북도";
  author: string | null;
  /** `YYYY-MM-DD` taken from the detail page's four-digit 작성일. */
  publishedDate: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  subheadings: string[];
  body: string;
  bodySha256: string;
  attachments: GbPressAttachment[];
  dataQualityIssues: GbPressQualityIssue[];
}

export interface GbPressCrawlOptions {
  outputDirectory: string;
  /** Inclusive lower bound on the published date, e.g. `2020-01-01`. */
  since: string;
  until?: string;
  maxOffset?: number;
  concurrency?: number;
  retries?: number;
  requestDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onProgress?: (message: string) => void;
  termsAcknowledged?: boolean;
  allowUnavailableRobots?: boolean;
  /** Reuses a previous run's detail pages so an interrupted crawl can resume. */
  resume?: boolean;
}

function listUrl(offset: number): string {
  const params = new URLSearchParams({
    URL: "/common/board/board.do",
    mnu_uid: GB_PRESS_MENU_UID,
    BD_CODE: GB_PRESS_BOARD_CODE,
    cmd: "1",
    B_LEVEL: "0",
    period: "0",
    key: "",
    word: "",
    p1: "",
    p2: "",
    B_START: "",
    B_END: "",
    Start: String(offset)
  });
  return `${GB_PRESS_BASE_URL}?${params.toString()}`;
}

export function gbPressDetailUrl(item: {
  boardNumber: string;
  sourceRecordId: string;
  viewNumber: string | null;
}): string {
  const params = new URLSearchParams({
    mnu_uid: GB_PRESS_MENU_UID,
    BD_CODE: GB_PRESS_BOARD_CODE,
    cmd: "2",
    Start: "0",
    B_NUM: item.boardNumber,
    B_STEP: item.sourceRecordId,
    B_LEVEL: "0",
    key: "4",
    word: "",
    p1: "0",
    p2: "0",
    ...(item.viewNumber ? { V_NUM: item.viewNumber } : {})
  });
  return `${GB_PRESS_BASE_URL}?${params.toString()}`;
}

/**
 * Expands the list view's two-digit year.
 *
 * The board only carries posts from the 2000s, so a year that would land in the
 * future is treated as ambiguous rather than silently shifted a century.
 */
export function expandTwoDigitYear(
  value: string,
  referenceYear: number
): { date: string | null; ambiguous: boolean } {
  const match = value.match(/^(\d{2})-(\d{2})-(\d{2})$/u);
  if (!match) return { date: null, ambiguous: false };
  const [, yy, mm, dd] = match;
  const year = 2000 + Number(yy);
  if (year > referenceYear + 1) return { date: null, ambiguous: true };
  const candidate = `${year}-${mm}-${dd}`;
  return { date: isValidIsoDate(candidate) ? candidate : null, ambiguous: false };
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function absoluteUrl(href: string): string {
  return new URL(decodeHtml(href.trim()), GB_PRESS_BASE_URL).toString();
}

function queryParam(url: string, name: string): string | null {
  try {
    return new URL(url).searchParams.get(name);
  } catch {
    return null;
  }
}

export function parseGbPressListPage(
  html: string,
  referenceYear: number
): GbPressListItem[] {
  const items: GbPressListItem[] = [];
  const blocks = html.matchAll(
    /<div class="report_cont">([\s\S]*?)<\/li>/giu
  );
  for (const block of blocks) {
    const section = block[1] ?? "";
    const anchor = section.match(
      /<div class="subject">[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu
    );
    if (!anchor) continue;
    const detailUrl = absoluteUrl(anchor[1] ?? "");
    const boardNumber = queryParam(detailUrl, "B_NUM");
    const sourceRecordId = queryParam(detailUrl, "B_STEP");
    if (!boardNumber || !sourceRecordId) continue;
    const classify = section.match(
      /<div class="classify">([\s\S]*?)<\/div>/iu
    )?.[1];
    const spans = classify
      ? [...classify.matchAll(/<span>([\s\S]*?)<\/span>/giu)].map((match) =>
          normalizedText(match[1] ?? "")
        )
      : [];
    const rawDate = spans.find((value) => /^\d{2}-\d{2}-\d{2}$/u.test(value)) ?? "";
    const excerpt = normalizedText(
      section.match(/<div class="cont">([\s\S]*?)<\/div>/iu)?.[1] ?? ""
    );
    items.push({
      sourceRecordId,
      boardNumber,
      viewNumber: queryParam(detailUrl, "V_NUM"),
      title: normalizedText(anchor[2] ?? ""),
      department: spans[0] && spans[0] !== rawDate ? spans[0] : null,
      phone: spans[1] && spans[1] !== rawDate ? spans[1] : null,
      listedDate: expandTwoDigitYear(rawDate, referenceYear).date,
      excerpt: excerpt.length > 0 ? excerpt : null,
      detailUrl
    });
  }
  return items;
}

function definitionValue(html: string, label: string): string | null {
  const pattern = new RegExp(
    `<dt[^>]*>\\s*<span>\\s*${label}\\s*<\\/span>\\s*<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>`,
    "iu"
  );
  const value = normalizedText(html.match(pattern)?.[1] ?? "");
  return value.length > 0 ? value : null;
}

function parseAttachments(html: string): GbPressAttachment[] {
  const block = html.match(
    /<dt[^>]*>\s*<span>\s*첨부파일\s*<\/span>\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/iu
  )?.[1];
  if (!block) return [];
  const attachments: GbPressAttachment[] = [];
  const seen = new Set<string>();
  for (const match of block.matchAll(
    /<a\s+href="([^"]*download\.jsp[^"]*)"[^>]*>([\s\S]*?)<\/a>/giu
  )) {
    const url = absoluteUrl(match[1] ?? "");
    if (seen.has(url)) continue;
    seen.add(url);
    const order = queryParam(url, "B_ORDER");
    attachments.push({
      name: normalizedText(match[2] ?? ""),
      url,
      order: order !== null && /^\d+$/u.test(order) ? Number(order) : null
    });
  }
  return attachments;
}

export function parseGbPressDetail(
  html: string,
  item: GbPressListItem
): GbPressRelease {
  const issues: GbPressQualityIssue[] = [];
  const detailTitle = normalizedText(
    html.match(/<div class="subject">([\s\S]*?)<\/div>/iu)?.[1] ?? ""
  );
  const title = detailTitle.length > 0 ? detailTitle : item.title;
  if (
    detailTitle.length > 0 &&
    item.title.length > 0 &&
    detailTitle !== item.title
  ) {
    issues.push({
      field: "title",
      rawValue: item.title,
      normalizedValue: detailTitle,
      issueCode: "title_mismatch"
    });
  }

  const writtenAt = definitionValue(html, "작성일");
  let publishedDate: string | null = null;
  let publishedAt: string | null = null;
  if (writtenAt) {
    const match = writtenAt.match(
      /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}:\d{2}))?/u
    );
    if (match && isValidIsoDate(match[1] ?? "")) {
      publishedDate = match[1] ?? null;
      publishedAt = match[2] ? `${match[1]}T${match[2]}` : null;
    } else {
      issues.push({
        field: "publishedDate",
        rawValue: writtenAt,
        normalizedValue: null,
        issueCode: "invalid_published_date"
      });
    }
  }
  if (!publishedDate) {
    // The list view's date is the only remaining signal. It is kept, but the
    // record is flagged so it is never mistaken for a precise timestamp.
    publishedDate = item.listedDate;
    issues.push({
      field: "publishedDate",
      rawValue: writtenAt ?? "",
      normalizedValue: item.listedDate,
      issueCode: "missing_published_date"
    });
  }

  const contentView = html.match(
    /<div class="cont_view">([\s\S]*?)(?:<!--\s*이전글다음글|<div class="bbsView")/iu
  )?.[1];
  const subheadingBlock = contentView?.match(
    /<div class="view_titlesub">([\s\S]*?)<\/div>/iu
  )?.[1];
  const subheadings = subheadingBlock
    ? normalizedBlockText(subheadingBlock)
        .split("\n")
        .map((line) => line.replace(/^[-–—\s]+|[-–—\s]+$/gu, "").trim())
        .filter((line) => line.length > 0)
    : [];

  const bodySource = (contentView ?? "")
    // The template leaves the title in a commented-out block; without this the
    // heading leaks into the body and every record starts by repeating itself.
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<div class="view_titlesub">[\s\S]*?<\/div>/giu, "")
    .replace(
      /<div class="reportview_img"[\s\S]*?<p class="explain">[\s\S]*?<\/p>\s*<\/div>/giu,
      ""
    )
    .replace(/<script[\s\S]*?<\/script>/giu, "");
  const body = normalizedBlockText(bodySource);
  if (body.length === 0) {
    issues.push({
      field: "body",
      rawValue: "",
      normalizedValue: null,
      issueCode: "empty_body"
    });
  }

  const viewCountRaw = definitionValue(html, "조회수");
  const viewCount =
    viewCountRaw && /^\d[\d,]*$/u.test(viewCountRaw)
      ? Number(viewCountRaw.replace(/,/gu, ""))
      : null;

  return {
    ...item,
    title,
    provinceName: "경상북도",
    department: definitionValue(html, "부서명") ?? item.department,
    phone: definitionValue(html, "전화번호") ?? item.phone,
    author: definitionValue(html, "작성자"),
    publishedDate,
    publishedAt,
    viewCount,
    subheadings,
    body,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    attachments: parseAttachments(html),
    dataQualityIssues: issues
  };
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /["\n,]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function gbPressReleasesToCsv(releases: GbPressRelease[]): string {
  const header = [
    "source_record_id",
    "published_date",
    "published_at",
    "province_name",
    "department",
    "phone",
    "author",
    "title",
    "subheadings",
    "body",
    "attachment_names",
    "view_count",
    "body_sha256",
    "detail_url"
  ];
  const rows = releases.map((release) =>
    [
      release.sourceRecordId,
      release.publishedDate,
      release.publishedAt,
      release.provinceName,
      release.department,
      release.phone,
      release.author,
      release.title,
      release.subheadings.join(" | "),
      release.body,
      release.attachments.map((file) => file.name).join(" | "),
      release.viewCount,
      release.bodySha256,
      release.detailUrl
    ]
      .map(csvCell)
      .join(",")
  );
  return `${[header.join(","), ...rows].join("\n")}\n`;
}

export const GB_PRESS_JSON_FILENAME = "gb_press_releases.json";
export const GB_PRESS_CSV_FILENAME = "경상북도_보도자료.csv";
export const GB_PRESS_METADATA_FILENAME = "gb_press_releases.metadata.json";

async function readExistingReleases(
  path: string
): Promise<Map<string, GbPressRelease>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as GbPressRelease[];
    return new Map(parsed.map((release) => [release.sourceRecordId, release]));
  } catch {
    return new Map();
  }
}

export async function crawlGbPressReleases(options: GbPressCrawlOptions): Promise<{
  releases: GbPressRelease[];
  jsonPath: string;
  csvPath: string;
  metadataPath: string;
}> {
  if (!options.termsAcknowledged) {
    throw new Error(
      "The operator must pass termsAcknowledged after reviewing the public site's terms and crawl policy"
    );
  }
  if (!isValidIsoDate(options.since)) {
    throw new Error("since must be an ISO date such as 2020-01-01");
  }
  if (options.until && !isValidIsoDate(options.until)) {
    throw new Error("until must be an ISO date such as 2026-08-22");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = options.concurrency ?? 2;
  const retries = options.retries ?? 3;
  const delayMs = options.requestDelayMs ?? 400;
  const maxOffset = options.maxOffset ?? 20_000;
  const progress = options.onProgress ?? (() => undefined);
  const retrievedAt = (options.now ?? (() => new Date()))();
  const referenceYear = retrievedAt.getUTCFullYear();
  const waitForRequest = createRequestGate(delayMs);
  const get = (url: string) =>
    fetchText(
      url,
      fetchImpl,
      retries,
      delayMs,
      waitForRequest,
      GB_PRESS_CRAWLER_USER_AGENT
    );

  let robotsStatus: "allowed" | "acknowledged_unavailable";
  try {
    const robots = await get(GB_PRESS_ROBOTS_URL);
    const allowed = robotsAllowsPath(
      robots,
      GB_PRESS_LIST_PATH,
      GB_PRESS_CRAWLER_USER_AGENT
    );
    if (allowed === false) {
      throw new Error("robots.txt disallows the Gyeongbuk press release path");
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
      error.message.startsWith("robots.txt disallows")
    ) {
      throw error;
    }
    if (!options.allowUnavailableRobots) throw error;
    robotsStatus = "acknowledged_unavailable";
  }
  progress(`robots.txt: ${robotsStatus}`);

  const jsonPath = resolve(options.outputDirectory, GB_PRESS_JSON_FILENAME);
  const csvPath = resolve(options.outputDirectory, GB_PRESS_CSV_FILENAME);
  const metadataPath = resolve(
    options.outputDirectory,
    GB_PRESS_METADATA_FILENAME
  );
  const cached = options.resume
    ? await readExistingReleases(jsonPath)
    : new Map<string, GbPressRelease>();
  if (cached.size > 0) progress(`resuming with ${cached.size} cached records`);

  const listed = new Map<string, GbPressListItem>();
  let offset = 0;
  let pagesRead = 0;
  let reachedCutoff = false;
  while (offset <= maxOffset) {
    const html = await get(listUrl(offset));
    const items = parseGbPressListPage(html, referenceYear);
    pagesRead += 1;
    if (items.length === 0) {
      progress(`offset ${offset}: end of board`);
      break;
    }
    for (const item of items) {
      if (!listed.has(item.sourceRecordId)) listed.set(item.sourceRecordId, item);
    }
    // Rows are ordered newest first, so once an entire page predates the
    // cutoff there is nothing older worth walking to.
    const dated = items.filter((item) => item.listedDate !== null);
    if (dated.length > 0 && dated.every((item) => item.listedDate! < options.since)) {
      reachedCutoff = true;
      progress(`offset ${offset}: reached ${options.since} cutoff`);
      break;
    }
    if (pagesRead % 25 === 0) {
      progress(`offset ${offset}: ${listed.size} listed`);
    }
    offset += GB_PRESS_PAGE_SIZE;
  }

  const candidates = [...listed.values()].filter((item) => {
    if (item.listedDate === null) return true;
    if (item.listedDate < options.since) return false;
    return !options.until || item.listedDate <= options.until;
  });
  progress(`fetching ${candidates.length} detail pages`);

  let fetched = 0;
  const releases = await mapConcurrent(candidates, concurrency, async (item) => {
    const existing = cached.get(item.sourceRecordId);
    if (existing) {
      fetched += 1;
      return existing;
    }
    const detail = await get(item.detailUrl);
    fetched += 1;
    if (fetched % 100 === 0) {
      progress(`detail ${fetched}/${candidates.length}`);
    }
    return parseGbPressDetail(detail, item);
  });

  const withinRange = releases.filter((release) => {
    if (!release.publishedDate) return true;
    if (release.publishedDate < options.since) return false;
    return !options.until || release.publishedDate <= options.until;
  });
  withinRange.sort(
    (left, right) =>
      (right.publishedDate ?? "").localeCompare(left.publishedDate ?? "") ||
      right.sourceRecordId.localeCompare(left.sourceRecordId)
  );

  await atomicWrite(jsonPath, `${JSON.stringify(withinRange, null, 2)}\n`);
  await atomicWrite(csvPath, gbPressReleasesToCsv(withinRange));
  await atomicWrite(
    metadataPath,
    `${JSON.stringify(
      {
        dataset: "gyeongbuk_press_release",
        provider: "경상북도",
        listUrl: listUrl(0),
        retrievedAt: retrievedAt.toISOString(),
        robots: { url: GB_PRESS_ROBOTS_URL, status: robotsStatus },
        range: { since: options.since, until: options.until ?? null },
        pagesRead,
        reachedCutoff,
        listedRecords: listed.size,
        storedRecords: withinRange.length,
        recordsWithQualityIssues: withinRange.filter(
          (release) => release.dataQualityIssues.length > 0
        ).length,
        acknowledgement: {
          termsReviewed: true,
          robotsUnavailableAcknowledged:
            robotsStatus === "acknowledged_unavailable"
        }
      },
      null,
      2
    )}\n`
  );

  return { releases: withinRange, jsonPath, csvPath, metadataPath };
}
