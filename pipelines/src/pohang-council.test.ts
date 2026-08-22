import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./etl.js";
import {
  crawlPohangBills,
  parsePohangBillDetail,
  parsePohangListPage,
  pohangBillsToCsv,
  robotsAllowsPath
} from "./pohang-council.js";

const listHtml = `
<div class="board_page">전체 <strong class="num1">3,112</strong>,
<strong class="num2">1</strong> / <strong class="num3">312</strong>쪽</div>
<div class="board_body"><table><tbody><tr>
<td class="bill_billnumber">10 - 22</td>
<td class="left bill_billname"><a href="?pg=vv&amp;number=3336&amp;page=1">민생경제 &amp; 지원 결의안</a></td>
<td class="bill_proposer">의회운영위원장</td><td class="bill_session">332</td>
<td class="bill_date">2026-07-27</td></tr></tbody></table></div>`;

const detailHtml = `<div class="pcViewer"><table class="table_bill"><tbody>
<tr><th>의안명</th><td>민생경제 &amp; 지원 결의안</td></tr>
<tr><th>공유된 의원</th><td></td></tr><tr><th>의안번호</th><td>10-22</td></tr>
<tr><th>회기</th><td>제332회</td></tr><tr><th>발의일</th><td>2026-07-27</td></tr>
<tr><th>발의자</th><td>의회운영위원장</td></tr><tr><th>이송일</th><td>2026-07-29</td></tr>
<tr><th>첨부파일</th><td><a href='/bill_download.html?number=2387'>결의안.pdf</a></td></tr>
<tr><th colspan="2">위원회</th></tr><tr><th>소관위원회</th><td>의회운영위원회</td></tr>
<tr><th>회부일</th><td></td></tr><tr><th>상정일</th><td>2026-07-27</td></tr>
<tr><th>처리일</th><td>2026-07-27</td></tr><tr><th>결과</th><td>위원회안 채택</td></tr>
<tr><th colspan="2">본회의</th></tr><tr><th>상정일</th><td>2026-07-28</td></tr>
<tr><th>처리일</th><td>2026-07-28</td></tr><tr><th>결과</th><td>원안가결</td></tr>
</tbody></table></div>`;

describe("Pohang council bill crawler", () => {
  it("parses list pagination and normalized rows", () => {
    expect(parsePohangListPage(listHtml)).toEqual({
      totalRecords: 3112,
      currentPage: 1,
      totalPages: 312,
      bills: [{
        sourceRecordId: 3336,
        billNumber: "10-22",
        title: "민생경제 & 지원 결의안",
        proposer: "의회운영위원장",
        sessionNumber: 332,
        receiptDate: "2026-07-27",
        detailUrl: "https://council.pohang.go.kr/content/activity/billSearch.html?pg=vv&number=3336&page=1"
      }]
    });
  });

  it("separates committee and plenary fields from the detail table", () => {
    const item = parsePohangListPage(listHtml).bills[0]!;
    expect(parsePohangBillDetail(detailHtml, item)).toMatchObject({
      billNumber: "10-22",
      proposalDate: "2026-07-27",
      committeeName: "의회운영위원회",
      committeeReferralDate: null,
      committeeResult: "위원회안 채택",
      plenaryDecisionDate: "2026-07-28",
      plenaryResult: "원안가결",
      attachments: [{
        name: "결의안.pdf",
        sourceAttachmentId: 2387,
        url: "https://council.pohang.go.kr/bill_download.html?number=2387"
      }],
      dataQualityIssues: []
    });
  });

  it("repairs the source's transposed 02xx years and records provenance", () => {
    const item = parsePohangListPage(listHtml).bills[0]!;
    const bill = parsePohangBillDetail(
      detailHtml.replace("2026-07-29", "0206-07-29"),
      item
    );
    expect(bill.transferDate).toBe("2006-07-29");
    expect(bill.dataQualityIssues).toEqual([{ 
      field: "transferDate",
      rawValue: "0206-07-29",
      normalizedValue: "2006-07-29",
      issueCode: "source_year_transposition"
    }]);
    expect(pohangBillsToCsv([bill])).toContain("source_year_transposition");
  });

  it("normalizes dotted dates and classifies zero-date sentinels", () => {
    const item = parsePohangListPage(listHtml).bills[0]!;
    const bill = parsePohangBillDetail(
      detailHtml
        .replace("2026-07-29", "2026.07.29.")
        .replace("<th>회부일</th><td></td>", "<th>회부일</th><td>0000-00-00</td>"),
      item
    );
    expect(bill.transferDate).toBe("2026-07-29");
    expect(bill.committeeReferralDate).toBeNull();
    expect(bill.dataQualityIssues.map((issue) => issue.issueCode)).toEqual([
      "source_date_delimiter_normalized",
      "missing_date_sentinel"
    ]);
  });

  it("honors explicit robots allow and disallow rules", () => {
    expect(
      robotsAllowsPath(
        "User-agent: *\nDisallow: /\nAllow: /content/activity/",
        "/content/activity/billSearch.html"
      )
    ).toBe(true);
    expect(
      robotsAllowsPath(
        "User-agent: *\nDisallow: /content/activity/",
        "/content/activity/billSearch.html"
      )
    ).toBe(false);
    expect(robotsAllowsPath("<html>blocked</html>", "/content/activity/")).toBeNull();
  });

  it("emits an ETL-compatible UTF-8 CSV with safe quoting", () => {
    const bill = parsePohangBillDetail(detailHtml, parsePohangListPage(listHtml).bills[0]!);
    const csv = pohangBillsToCsv([{ ...bill, title: '쉼표, "인용" 의안' }]);
    expect(csv.startsWith("\uFEFF의안번호,의안명,발의자")).toBe(true);
    expect(csv).toContain('"쉼표, ""인용"" 의안"');
    expect(csv).toContain(",원안가결,");
  });

  it("crawls all advertised pages and writes auditable outputs atomically", async () => {
    const outputDirectory = resolve(
      repositoryRoot,
      ".test-output",
      `pohang-council-${randomUUID()}`
    );
    const secondPage = listHtml
      .replace('<strong class="num1">3,112</strong>', '<strong class="num1">2</strong>')
      .replace('<strong class="num2">1</strong>', '<strong class="num2">2</strong>')
      .replace('<strong class="num3">312</strong>', '<strong class="num3">2</strong>')
      .replace(/3336/gu, "3335")
      .replace(/10 - 22/gu, "10 - 21")
      .replace(/민생경제 &amp; 지원 결의안/gu, "지역경제 지원 조례안");
    const firstPage = listHtml
      .replace('<strong class="num1">3,112</strong>', '<strong class="num1">2</strong>')
      .replace('<strong class="num3">312</strong>', '<strong class="num3">2</strong>');
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/robots.txt")) {
        return new Response(
          "User-agent: *\nAllow: /content/activity/"
        );
      }
      if (url.includes("number=3335")) {
        return new Response(detailHtml.replace(/10-22/gu, "10-21").replace(/민생경제 &amp; 지원 결의안/gu, "지역경제 지원 조례안"));
      }
      if (url.includes("number=3336")) return new Response(detailHtml);
      return new Response(url.endsWith("page=2") ? secondPage : firstPage);
    }) as typeof fetch;

    try {
      const result = await crawlPohangBills({
        outputDirectory,
        concurrency: 2,
        requestDelayMs: 250,
        fetchImpl,
        now: () => new Date("2026-08-22T00:00:00.000Z"),
        termsAcknowledged: true
      });
      expect(result.bills.map((bill) => bill.sourceRecordId)).toEqual([3336, 3335]);
      expect(requested).toHaveLength(5);
      expect(JSON.parse(await readFile(result.metadataPath, "utf8"))).toMatchObject({
        crawledAt: "2026-08-22T00:00:00.000Z",
        retrievedAt: "2026-08-22T00:00:00.000Z",
        robots: {
          status: "allowed"
        },
        requestPolicy: {
          minimumIntervalMs: 250,
          concurrency: 2
        },
        recordCount: 2,
        proposalDateCoverage: { start: "2026-07-27", end: "2026-07-27" },
        attachmentCount: 2,
        dataQualityIssueCount: 0,
        sha256: {
          json: expect.stringMatching(/^[0-9a-f]{64}$/u),
          csv: expect.stringMatching(/^[0-9a-f]{64}$/u)
        }
      });
      expect((await readFile(result.csvPath, "utf8")).split("\n")).toHaveLength(4);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
