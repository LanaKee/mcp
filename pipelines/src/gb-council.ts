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

/**
 * Crawler for 경상북도의회 (Gyeongbuk Provincial Council).
 *
 * The site is a WebSquare-free server-rendered app whose search state lives in
 * an inline `var st_data = {...}` object. Every list view is a plain GET with
 * `page=N` and a fixed ten rows per page (`limit` is accepted but ignored by
 * the server), which is why the crawler walks pages rather than offsets.
 *
 * Two views matter here:
 *
 * - `/kr/member/name` renders the whole roster in one 300 KB document,
 *   including each member's district, party, committee post and career, so the
 *   roster costs exactly one request.
 * - `/member/bill/contents?search_code=<code>` lists the bills a member is
 *   attached to. The list row does not say whether they led the bill, so the
 *   detail page has to be fetched to separate 대표발의 from 공동발의.
 */

export const GB_COUNCIL_ORIGIN = "https://council.gb.go.kr";
export const GB_COUNCIL_ROBOTS_URL = `${GB_COUNCIL_ORIGIN}/robots.txt`;
export const GB_COUNCIL_ROSTER_PATH = "/kr/member/name";
export const GB_COUNCIL_MEMBER_BILL_PATH = "/member/bill/contents";
export const GB_COUNCIL_PAGE_SIZE = 10;
export const GB_COUNCIL_CRAWLER_USER_AGENT =
  "gb-public-data-mcp/0.1 (+https://github.com/LanaKee/mcp; contact: operator)";

export const GB_COUNCIL_MEMBER_JSON_FILENAME = "gb_council_members.json";
export const GB_COUNCIL_MEMBER_CSV_FILENAME = "경상북도의회_의원.csv";
export const GB_COUNCIL_BILL_JSON_FILENAME = "gb_council_bills.json";
export const GB_COUNCIL_BILL_CSV_FILENAME = "경상북도의회_의안.csv";
export const GB_COUNCIL_SPONSOR_CSV_FILENAME = "경상북도의회_의안발의자.csv";
export const GB_COUNCIL_METADATA_FILENAME = "gb_council.metadata.json";

export interface GbCouncilMember {
  /** Stable-looking site key used as `search_code` in every member URL. */
  searchCode: string;
  /** Numeric key behind the profile popup ids; null when the popup is absent. */
  siteMemberId: string | null;
  name: string;
  party: string | null;
  district: string | null;
  /** Committee post such as "문화환경위원회 위원장". */
  position: string | null;
  officePhone: string | null;
  education: string | null;
  career: string | null;
  photoUrl: string | null;
  homepageUrl: string;
  billListUrl: string;
}

export type GbCouncilSponsorRole = "lead" | "co";

export interface GbCouncilBillSponsor {
  billUid: string;
  role: GbCouncilSponsorRole;
  memberName: string;
  /** Filled in once the roster is matched by name; null for former members. */
  searchCode: string | null;
}

export interface GbCouncilBill {
  /** 32-hex `uid` the site uses as the bill primary key. */
  billUid: string;
  /** 의안번호 as printed, e.g. "1327". */
  billNumber: string | null;
  title: string;
  /** 제안자 as printed on the list row, e.g. "의원", "도지사". */
  proposerKind: string | null;
  committee: string | null;
  /** 발의일 / 접수일자 in ISO form. */
  proposedDate: string | null;
  /** 의결일 in ISO form. */
  decidedDate: string | null;
  /** 상태 as printed, e.g. "처리완료", "접수완료". */
  status: string | null;
  /** 처리결과 from the committee or plenary table, e.g. "원안가결". */
  outcome: string | null;
  /** 제안회기, e.g. "제364회 경상북도의회 임시회". */
  session: string | null;
  /** 의안종류 inferred from the bill title, e.g. "조례안". */
  billKind: string | null;
  leadSponsors: string[];
  coSponsors: string[];
  detailUrl: string;
  /** search_code values whose bill list contained this bill. */
  listedForSearchCodes: string[];
}

export interface GbCouncilCrawlOptions {
  outputDirectory: string;
  termsAcknowledged: boolean;
  allowUnavailableRobots?: boolean;
  resume?: boolean;
  /** Restricts the crawl to these search codes; defaults to the whole roster. */
  onlySearchCodes?: string[];
  /** Safety valve for the per-member page walk. */
  maxPagesPerMember?: number;
  concurrency?: number;
  retries?: number;
  requestDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onProgress?: (message: string) => void;
}

const BILL_KINDS = [
  "조례안",
  "규칙안",
  "결의안",
  "건의안",
  "동의안",
  "승인안",
  "예산안",
  "결산",
  "청원",
  "의견제시",
  "인사청문"
] as const;

export function absoluteCouncilUrl(href: string): string {
  if (/^https?:\/\//u.test(href)) return href;
  return `${GB_COUNCIL_ORIGIN}${href.startsWith("/") ? href : `/${href}`}`;
}

export function gbCouncilMemberBillListUrl(
  searchCode: string,
  page = 1
): string {
  return `${GB_COUNCIL_ORIGIN}${GB_COUNCIL_MEMBER_BILL_PATH}?search_code=${encodeURIComponent(
    searchCode
  )}&page=${page}`;
}

export function gbCouncilBillDetailUrl(
  billUid: string,
  searchCode: string
): string {
  return `${GB_COUNCIL_ORIGIN}${GB_COUNCIL_MEMBER_BILL_PATH}?reform=view&uid=${encodeURIComponent(
    billUid
  )}&search_code=${encodeURIComponent(searchCode)}`;
}

/** Normalises the site's `2026-07-16` and `2026.07.16` date renderings. */
export function normalizeCouncilDate(value: string | null): string | null {
  if (!value) return null;
  const match = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/u.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/** Infers the bill category from the printed title, mirroring the site filter. */
export function inferBillKind(title: string): string | null {
  for (const kind of BILL_KINDS) {
    if (title.includes(kind)) return kind;
  }
  return null;
}

function tableCells(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/giu)].map((match) =>
    normalizedText(match[1] ?? "")
  );
}

/**
 * Returns the data rows of a table.
 *
 * Several detail tables on this site omit `<tbody>` entirely, so the body is
 * used when present and otherwise every `<tr>` carrying a `<td>` is treated as
 * a data row. Header-only rows are dropped either way.
 */
function tableRows(html: string): string[] {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/iu.exec(html);
  const scope = body ? body[1] ?? "" : html;
  return [...scope.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/giu)]
    .map((match) => match[1] ?? "")
    .filter((row) => /<td[^>]*>/iu.test(row));
}

/**
 * Splits the roster document into one block per `div.profile` card.
 *
 * The cards contain nested `div`s (name, sns, btns) so a non-greedy
 * `</div></div>` match would stop early; slicing on the card openings is both
 * simpler and robust to future nesting changes.
 */
function profileCards(html: string): string[] {
  const starts = [...html.matchAll(/<div class="profile(?:\s[^"]*)?">/giu)].map(
    (match) => match.index ?? 0
  );
  return starts.map((start, index) =>
    html.slice(start, starts[index + 1] ?? html.length)
  );
}

/**
 * Parses `/kr/member/name`.
 *
 * The document contains each member twice: once in the header's site-wide
 * dropdown and once as a `div.profile` card. Only the card carries the party,
 * district and committee post, so the cards drive the parse and the profile
 * popups are joined on the numeric id embedded in `btn_profileNNN`.
 */
export function parseGbCouncilRoster(html: string): GbCouncilMember[] {
  const profiles = new Map<string, string>();
  for (const match of html.matchAll(
    /id="pop(\d+)"([\s\S]*?)(?=<div[^>]+id="pop\d+"|<div id="footer"|$)/giu
  )) {
    profiles.set(match[1] ?? "", match[2] ?? "");
  }

  const members: GbCouncilMember[] = [];
  const seen = new Set<string>();
  for (const block of profileCards(html)) {
    const homepage = /href="(\/member\/main\?search_code=([^"&]+))"/iu.exec(block);
    if (!homepage) continue;
    const searchCode = homepage[2] ?? "";
    if (!searchCode || seen.has(searchCode)) continue;
    seen.add(searchCode);

    const name = normalizedText(
      /<strong>([\s\S]*?)<\/strong>/iu.exec(block)?.[1] ?? ""
    );
    if (!name) continue;

    const fields = new Map<string, string>();
    for (const item of block.matchAll(
      /<li><em>([\s\S]*?)<\/em>[\s\S]*?<span class="colon">:<\/span><span>([\s\S]*?)<\/span><\/li>/giu
    )) {
      const label = normalizedText(item[1] ?? "").replace(/\s+/gu, "");
      fields.set(label, normalizedText(item[2] ?? ""));
    }

    const photo = /<img src="([^"]+)"/iu.exec(block)?.[1] ?? null;
    const popupId = /id="btn_profile(\d+)"/iu.exec(block)?.[1] ?? null;
    const popup = popupId ? profiles.get(popupId) ?? "" : "";

    members.push({
      searchCode,
      siteMemberId: popupId,
      name,
      party: fields.get("소속정당") || null,
      district: fields.get("선거구") || null,
      position: fields.get("직위") || null,
      officePhone: popup ? parseProfilePhone(popup) : null,
      education: popup ? parseProfileSection(popup, "학력사항") : null,
      career: popup ? parseProfileSection(popup, "경력사항") : null,
      photoUrl: photo ? absoluteCouncilUrl(decodeHtml(photo)) : null,
      homepageUrl: absoluteCouncilUrl(decodeHtml(homepage[1] ?? "")),
      billListUrl: gbCouncilMemberBillListUrl(searchCode)
    });
  }

  members.sort((left, right) => left.name.localeCompare(right.name, "ko"));
  return members;
}

function parseProfilePhone(popup: string): string | null {
  const text = normalizedBlockText(popup);
  const match = /사\s*무\s*실\s*\n?\s*([0-9][0-9\-() ]{6,})/u.exec(text);
  return match ? (match[1] ?? "").trim() : null;
}

/**
 * Pulls one `<학력사항>` / `<경력사항>` block out of the profile popup.
 *
 * The popup prints the headings inside literal angle brackets, which survive
 * the tag stripper only because they are HTML-escaped in the source.
 */
function parseProfileSection(popup: string, heading: string): string | null {
  const text = normalizedBlockText(popup);
  const start = text.indexOf(`<${heading}>`);
  if (start < 0) return null;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/<(?:학력사항|경력사항|수상|저서)[^>]*>/u);
  const section = (next < 0 ? rest : rest.slice(0, next))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "x close")
    .join("\n")
    .trim();
  return section || null;
}

export interface GbCouncilBillListRow {
  billUid: string;
  billNumber: string | null;
  title: string;
  proposerKind: string | null;
  committee: string | null;
  proposedDate: string | null;
  status: string | null;
  decidedDate: string | null;
}

/**
 * Parses one page of `/member/bill/contents`.
 *
 * The table is 의안번호 / 의안명 / 제안자 / 소관위원회 / 발의일 / 상태 / 의결일.
 * An empty result renders a single colspan row with no link, which is why rows
 * without a `uid` are dropped rather than treated as a parse failure.
 */
export function parseGbCouncilBillList(html: string): GbCouncilBillListRow[] {
  const rows: GbCouncilBillListRow[] = [];
  for (const raw of tableRows(html)) {
    const uid = /uid=([0-9A-Fa-f]{32})/u.exec(raw)?.[1];
    if (!uid) continue;
    const cells = tableCells(raw);
    if (cells.length < 5) continue;
    rows.push({
      billUid: uid.toUpperCase(),
      billNumber: cells[0] || null,
      title: cells[1] ?? "",
      proposerKind: cells[2] || null,
      committee: cells[3] || null,
      proposedDate: normalizeCouncilDate(cells[4] ?? null),
      status: cells[5] || null,
      decidedDate: normalizeCouncilDate(cells[6] ?? null)
    });
  }
  return rows;
}

export interface GbCouncilBillDetail {
  leadSponsors: string[];
  coSponsors: string[];
  session: string | null;
  outcome: string | null;
  proposedDate: string | null;
  decidedDate: string | null;
  committee: string | null;
  proposerKind: string | null;
}

/**
 * Parses a bill detail page.
 *
 * The page is a stack of captioned tables. Captions are matched rather than
 * positions because the plenary and transfer tables are omitted entirely for
 * bills that never reached those stages.
 */
export function parseGbCouncilBillDetail(html: string): GbCouncilBillDetail {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/giu)].map(
    (match) => match[0]
  );
  const byCaption = (needle: string): string | null =>
    tables.find((table) => {
      const caption = /<caption[^>]*>([\s\S]*?)<\/caption>/iu.exec(table)?.[1];
      return caption ? normalizedText(caption).includes(needle) : false;
    }) ?? null;

  const sponsorTable = byCaption("대표발의자");
  const leadSponsors: string[] = [];
  const coSponsors: string[] = [];
  if (sponsorTable) {
    for (const row of [...sponsorTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/giu)]) {
      const block = row[1] ?? "";
      const label = normalizedText(
        /<th[^>]*>([\s\S]*?)<\/th>/iu.exec(block)?.[1] ?? ""
      );
      if (!label) continue;
      const names = tableCells(block)
        .flatMap((cell) => cell.split(/[,·\s]+/u))
        .map((name) => name.trim())
        .filter((name) => /^[가-힣]{2,6}$/u.test(name));
      if (label.includes("대표발의")) leadSponsors.push(...names);
      else if (label.includes("공동발의")) coSponsors.push(...names);
    }
  }

  const receipt = byCaption("의안번호");
  let session: string | null = null;
  let proposedDate: string | null = null;
  let proposerKind: string | null = null;
  if (receipt) {
    const cells = tableRows(receipt).flatMap(tableCells);
    proposedDate = normalizeCouncilDate(cells[1] ?? null);
    session = cells[2] || null;
    proposerKind = cells[3] || null;
  }

  const committeeTable = byCaption("소관위원회");
  let committee: string | null = null;
  let outcome: string | null = null;
  if (committeeTable) {
    const cells = tableRows(committeeTable).flatMap(tableCells);
    committee = cells[0] || null;
    outcome = cells[4] || null;
  }

  const plenary = byCaption("본회의 회의정보");
  let decidedDate: string | null = null;
  if (plenary) {
    const cells = tableRows(plenary).flatMap(tableCells);
    decidedDate = normalizeCouncilDate(cells[2] ?? null);
    outcome = cells[3] || outcome;
  }

  return {
    leadSponsors: [...new Set(leadSponsors)],
    coSponsors: [...new Set(coSponsors)],
    session,
    outcome,
    proposedDate,
    decidedDate,
    committee,
    proposerKind
  };
}

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function gbCouncilMembersToCsv(members: GbCouncilMember[]): string {
  const header = [
    "search_code",
    "site_member_id",
    "name",
    "party",
    "district",
    "position",
    "office_phone",
    "education",
    "career",
    "photo_url",
    "homepage_url"
  ];
  const lines = [header.join(",")];
  for (const member of members) {
    lines.push(
      [
        member.searchCode,
        member.siteMemberId,
        member.name,
        member.party,
        member.district,
        member.position,
        member.officePhone,
        member.education,
        member.career,
        member.photoUrl,
        member.homepageUrl
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

export function gbCouncilBillsToCsv(bills: GbCouncilBill[]): string {
  const header = [
    "bill_uid",
    "bill_number",
    "title",
    "bill_kind",
    "proposer_kind",
    "committee",
    "session",
    "proposed_date",
    "decided_date",
    "status",
    "outcome",
    "lead_sponsors",
    "co_sponsor_count",
    "detail_url"
  ];
  const lines = [header.join(",")];
  for (const bill of bills) {
    lines.push(
      [
        bill.billUid,
        bill.billNumber,
        bill.title,
        bill.billKind,
        bill.proposerKind,
        bill.committee,
        bill.session,
        bill.proposedDate,
        bill.decidedDate,
        bill.status,
        bill.outcome,
        bill.leadSponsors.join(";"),
        bill.coSponsors.length,
        bill.detailUrl
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

export function gbCouncilSponsorsToCsv(sponsors: GbCouncilBillSponsor[]): string {
  const lines = ["bill_uid,role,member_name,search_code"];
  for (const sponsor of sponsors) {
    lines.push(
      [sponsor.billUid, sponsor.role, sponsor.memberName, sponsor.searchCode]
        .map(csvCell)
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

async function readExistingBills(path: string): Promise<Map<string, GbCouncilBill>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as GbCouncilBill[];
    return new Map(parsed.map((bill) => [bill.billUid, bill]));
  } catch {
    return new Map();
  }
}

export async function crawlGbCouncil(options: GbCouncilCrawlOptions): Promise<{
  members: GbCouncilMember[];
  bills: GbCouncilBill[];
  sponsors: GbCouncilBillSponsor[];
  memberJsonPath: string;
  memberCsvPath: string;
  billJsonPath: string;
  billCsvPath: string;
  sponsorCsvPath: string;
  metadataPath: string;
}> {
  if (!options.termsAcknowledged) {
    throw new Error(
      "The operator must pass termsAcknowledged after reviewing the public site's terms and crawl policy"
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = options.concurrency ?? 2;
  const retries = options.retries ?? 3;
  const delayMs = options.requestDelayMs ?? 400;
  const maxPagesPerMember = options.maxPagesPerMember ?? 200;
  const progress = options.onProgress ?? (() => undefined);
  const retrievedAt = (options.now ?? (() => new Date()))();
  const waitForRequest = createRequestGate(delayMs);
  const get = (url: string) =>
    fetchText(
      url,
      fetchImpl,
      retries,
      delayMs,
      waitForRequest,
      GB_COUNCIL_CRAWLER_USER_AGENT
    );

  let robotsStatus: "allowed" | "acknowledged_unavailable";
  try {
    const robots = await get(GB_COUNCIL_ROBOTS_URL);
    const allowed = robotsAllowsPath(
      robots,
      GB_COUNCIL_ROSTER_PATH,
      GB_COUNCIL_CRAWLER_USER_AGENT
    );
    if (allowed === false) {
      throw new Error("robots.txt disallows the Gyeongbuk council member path");
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

  const memberJsonPath = resolve(
    options.outputDirectory,
    GB_COUNCIL_MEMBER_JSON_FILENAME
  );
  const memberCsvPath = resolve(
    options.outputDirectory,
    GB_COUNCIL_MEMBER_CSV_FILENAME
  );
  const billJsonPath = resolve(
    options.outputDirectory,
    GB_COUNCIL_BILL_JSON_FILENAME
  );
  const billCsvPath = resolve(
    options.outputDirectory,
    GB_COUNCIL_BILL_CSV_FILENAME
  );
  const sponsorCsvPath = resolve(
    options.outputDirectory,
    GB_COUNCIL_SPONSOR_CSV_FILENAME
  );
  const metadataPath = resolve(
    options.outputDirectory,
    GB_COUNCIL_METADATA_FILENAME
  );

  const rosterHtml = await get(`${GB_COUNCIL_ORIGIN}${GB_COUNCIL_ROSTER_PATH}`);
  const allMembers = parseGbCouncilRoster(rosterHtml);
  if (allMembers.length === 0) {
    throw new Error("roster page produced no members; the markup likely changed");
  }
  const members = options.onlySearchCodes
    ? allMembers.filter((member) =>
        options.onlySearchCodes!.includes(member.searchCode)
      )
    : allMembers;
  progress(`roster: ${members.length}/${allMembers.length} members selected`);

  const cached = options.resume
    ? await readExistingBills(billJsonPath)
    : new Map<string, GbCouncilBill>();
  if (cached.size > 0) progress(`resuming with ${cached.size} cached bills`);

  // Walk each member's bill list. The union of rows is the crawl frontier; a
  // bill co-sponsored by twelve members appears on twelve lists but is fetched
  // once.
  const rowsByUid = new Map<string, GbCouncilBillListRow>();
  const listedFor = new Map<string, Set<string>>();
  let listPages = 0;
  for (const [index, member] of members.entries()) {
    let page = 1;
    let memberRows = 0;
    while (page <= maxPagesPerMember) {
      const html = await get(
        gbCouncilMemberBillListUrl(member.searchCode, page)
      );
      listPages += 1;
      const rows = parseGbCouncilBillList(html);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (!rowsByUid.has(row.billUid)) rowsByUid.set(row.billUid, row);
        const codes = listedFor.get(row.billUid) ?? new Set<string>();
        codes.add(member.searchCode);
        listedFor.set(row.billUid, codes);
      }
      memberRows += rows.length;
      if (rows.length < GB_COUNCIL_PAGE_SIZE) break;
      page += 1;
    }
    progress(
      `member ${index + 1}/${members.length} ${member.name}: ${memberRows} rows (${rowsByUid.size} unique)`
    );
  }

  const codeByName = new Map<string, string>();
  for (const member of allMembers) {
    if (!codeByName.has(member.name)) codeByName.set(member.name, member.searchCode);
  }

  const frontier = [...rowsByUid.values()];
  progress(`fetching ${frontier.length} bill detail pages`);
  let fetched = 0;
  const bills = await mapConcurrent(frontier, concurrency, async (row) => {
    const codes = [...(listedFor.get(row.billUid) ?? new Set<string>())].sort();
    const existing = cached.get(row.billUid);
    if (existing) {
      fetched += 1;
      return { ...existing, listedForSearchCodes: codes } satisfies GbCouncilBill;
    }
    const anchor = codes[0] ?? members[0]?.searchCode ?? "";
    const detailUrl = gbCouncilBillDetailUrl(row.billUid, anchor);
    const detail = parseGbCouncilBillDetail(await get(detailUrl));
    fetched += 1;
    if (fetched % 100 === 0) {
      progress(`detail ${fetched}/${frontier.length}`);
    }
    return {
      billUid: row.billUid,
      billNumber: row.billNumber,
      title: row.title,
      proposerKind: row.proposerKind ?? detail.proposerKind,
      committee: row.committee ?? detail.committee,
      proposedDate: row.proposedDate ?? detail.proposedDate,
      decidedDate: row.decidedDate ?? detail.decidedDate,
      status: row.status,
      outcome: detail.outcome,
      session: detail.session,
      billKind: inferBillKind(row.title),
      leadSponsors: detail.leadSponsors,
      coSponsors: detail.coSponsors,
      detailUrl,
      listedForSearchCodes: codes
    } satisfies GbCouncilBill;
  });

  bills.sort(
    (left, right) =>
      (right.proposedDate ?? "").localeCompare(left.proposedDate ?? "") ||
      left.billUid.localeCompare(right.billUid)
  );

  const sponsors: GbCouncilBillSponsor[] = [];
  const sponsorSeen = new Set<string>();
  for (const bill of bills) {
    const push = (role: GbCouncilSponsorRole, name: string) => {
      const key = `${bill.billUid}|${role}|${name}`;
      if (sponsorSeen.has(key)) return;
      sponsorSeen.add(key);
      sponsors.push({
        billUid: bill.billUid,
        role,
        memberName: name,
        searchCode: codeByName.get(name) ?? null
      });
    };
    for (const name of bill.leadSponsors) push("lead", name);
    for (const name of bill.coSponsors) push("co", name);
  }

  await atomicWrite(memberJsonPath, `${JSON.stringify(members, null, 2)}\n`);
  await atomicWrite(memberCsvPath, gbCouncilMembersToCsv(members));
  await atomicWrite(billJsonPath, `${JSON.stringify(bills, null, 2)}\n`);
  await atomicWrite(billCsvPath, gbCouncilBillsToCsv(bills));
  await atomicWrite(sponsorCsvPath, gbCouncilSponsorsToCsv(sponsors));
  await atomicWrite(
    metadataPath,
    `${JSON.stringify(
      {
        dataset: "gyeongbuk_council",
        provider: "경상북도의회",
        rosterUrl: `${GB_COUNCIL_ORIGIN}${GB_COUNCIL_ROSTER_PATH}`,
        retrievedAt: retrievedAt.toISOString(),
        robots: { url: GB_COUNCIL_ROBOTS_URL, status: robotsStatus },
        rosterMembers: allMembers.length,
        crawledMembers: members.length,
        listPages,
        bills: bills.length,
        sponsorLinks: sponsors.length,
        sponsorLinksWithoutRosterMatch: sponsors.filter(
          (sponsor) => sponsor.searchCode === null
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

  return {
    members,
    bills,
    sponsors,
    memberJsonPath,
    memberCsvPath,
    billJsonPath,
    billCsvPath,
    sponsorCsvPath,
    metadataPath
  };
}
