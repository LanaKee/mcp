import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./etl.js";
import {
  crawlGbPressReleases,
  expandTwoDigitYear,
  gbPressDetailUrl,
  gbPressReleasesToCsv,
  parseGbPressDetail,
  parseGbPressListPage
} from "./gb-press-release.js";

const listItem = (step: number, title: string, date: string) => `
<li><div class="report_cont">
  <div class="subject"><p><a href="/Main/page.do?mnu_uid=6792&amp;BD_CODE=bbs_bodo&amp;cmd=2&amp;Start=0&amp;B_NUM=${
    step + 1
  }&amp;B_STEP=${step}&amp;B_LEVEL=0&amp;key=4&amp;V_NUM=99" title="${title}">${title}</a></p></div>
  <div class="classify"><span>메타버스과</span>｜<span>054-880-1234</span>｜<span>${date}</span></div>
  <div class="cont">${title} 요약문입니다.</div>
</div></li>`;

const listHtml = `<div class="report_list"><ul>
${listItem(100, "청년 창업 지원 &amp; 확대", "26-08-21")}
${listItem(99, "농촌 정주여건 개선", "26-08-20")}
</ul></div>`;

const detailHtml = (title: string, writtenAt: string, body: string) => `
<div class="bbsRead">
  <div class="subject">${title}</div>
  <div class="classify_list"><dl>
    <dt><span>부서명</span></dt><dd>메타버스과</dd>
    <dt><span>전화번호</span></dt><dd>054-880-1234</dd>
  </dl></div>
  <div class="classify_list"><dl>
    <dt><span>작성자</span></dt><dd>홍길동</dd>
    <dt><span>작성일</span></dt><dd>${writtenAt}</dd>
    <dt><span>조회수</span></dt><dd>1,234</dd>
  </dl></div>
  <div class="classify_list"><dl>
    <dt><span>첨부파일</span></dt>
    <dd>
      <a href="/Common/board_egov/download.jsp?B_STEP=100&amp;B_ORDER=1">보도자료.hwp</a>
      <a href="/Common/board_egov/download.jsp?B_STEP=100&amp;B_ORDER=2">사진.jpg</a>
    </dd>
  </dl></div>
  <div class="cont_view">
    <!--div class="view_title"> ${title} </div-->
    <div class="view_titlesub">- 도내 청년 500명 대상 -</div>
    <div class="reportview_img"><img src="/photo.jpg" alt="사진"/></div>
    ${body}
  </div>
  <!-- 이전글다음글 -->
  <div class="bbsView">이전글 목록</div>
</div>`;

describe("Gyeongbuk press release parser", () => {
  it("reads the board's stable post id and metadata from the list page", () => {
    const items = parseGbPressListPage(listHtml, 2026);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      sourceRecordId: "100",
      boardNumber: "101",
      viewNumber: "99",
      title: "청년 창업 지원 & 확대",
      department: "메타버스과",
      phone: "054-880-1234",
      listedDate: "2026-08-21",
      excerpt: "청년 창업 지원 & 확대 요약문입니다."
    });
    expect(items[1]!.sourceRecordId).toBe("99");
  });

  it("refuses to guess a two digit year that would fall in the future", () => {
    expect(expandTwoDigitYear("20-04-17", 2026)).toEqual({
      date: "2020-04-17",
      ambiguous: false
    });
    expect(expandTwoDigitYear("99-01-01", 2026)).toEqual({
      date: null,
      ambiguous: true
    });
    expect(expandTwoDigitYear("20-02-30", 2026)).toEqual({
      date: null,
      ambiguous: false
    });
  });

  it("builds a detail url from the post id rather than the row position", () => {
    const url = new URL(
      gbPressDetailUrl({ boardNumber: "101", sourceRecordId: "100", viewNumber: null })
    );
    expect(url.searchParams.get("B_STEP")).toBe("100");
    expect(url.searchParams.get("B_NUM")).toBe("101");
    expect(url.searchParams.has("V_NUM")).toBe(false);
  });

  it("extracts the body, subheadings and attachments from the detail page", () => {
    const item = parseGbPressListPage(listHtml, 2026)[0]!;
    const release = parseGbPressDetail(
      detailHtml(
        "청년 창업 지원 &amp; 확대",
        "2026-08-21 09:30:00",
        "경상북도는 21일 청년 창업 지원 사업을 발표했다.<br/><br/>도는 올해 500명을 지원한다."
      ),
      item
    );
    expect(release.publishedDate).toBe("2026-08-21");
    expect(release.publishedAt).toBe("2026-08-21T09:30:00");
    expect(release.department).toBe("메타버스과");
    expect(release.author).toBe("홍길동");
    expect(release.viewCount).toBe(1234);
    expect(release.subheadings).toEqual(["도내 청년 500명 대상"]);
    expect(release.attachments).toEqual([
      {
        name: "보도자료.hwp",
        url: "https://www.gb.go.kr/Common/board_egov/download.jsp?B_STEP=100&B_ORDER=1",
        order: 1
      },
      {
        name: "사진.jpg",
        url: "https://www.gb.go.kr/Common/board_egov/download.jsp?B_STEP=100&B_ORDER=2",
        order: 2
      }
    ]);
    expect(release.body).toContain("경상북도는 21일 청년 창업 지원 사업을 발표했다.");
    expect(release.dataQualityIssues).toEqual([]);
  });

  it("keeps the commented-out headline template out of the body", () => {
    // The board wraps the repeated headline in an HTML comment, which tag
    // stripping alone leaves behind and would duplicate the title into every
    // article body.
    const item = parseGbPressListPage(listHtml, 2026)[0]!;
    const release = parseGbPressDetail(
      detailHtml("청년 창업 지원 &amp; 확대", "2026-08-21 09:30:00", "본문 시작."),
      item
    );
    expect(release.body).toBe("본문 시작.");
    expect(release.body).not.toContain("청년 창업");
    expect(release.body).not.toContain("이전글");
  });

  it("falls back to the list date and flags the record when 작성일 is missing", () => {
    const item = parseGbPressListPage(listHtml, 2026)[0]!;
    const release = parseGbPressDetail(
      detailHtml("청년 창업 지원 &amp; 확대", "", "본문."),
      item
    );
    expect(release.publishedDate).toBe("2026-08-21");
    expect(release.publishedAt).toBeNull();
    expect(release.dataQualityIssues).toContainEqual({
      field: "publishedDate",
      rawValue: "",
      normalizedValue: "2026-08-21",
      issueCode: "missing_published_date"
    });
  });

  it("prefers the detail title and records the disagreement with the list", () => {
    const item = parseGbPressListPage(listHtml, 2026)[0]!;
    const release = parseGbPressDetail(
      detailHtml("청년 창업 지원 확대 계획", "2026-08-21 09:30:00", "본문."),
      item
    );
    expect(release.title).toBe("청년 창업 지원 확대 계획");
    expect(release.dataQualityIssues).toContainEqual({
      field: "title",
      rawValue: "청년 창업 지원 & 확대",
      normalizedValue: "청년 창업 지원 확대 계획",
      issueCode: "title_mismatch"
    });
  });

  it("escapes multi-line bodies so the csv stays parseable", () => {
    const item = parseGbPressListPage(listHtml, 2026)[0]!;
    const release = parseGbPressDetail(
      detailHtml("제목, 쉼표", "2026-08-21 09:30:00", '따옴표 "인용" 포함.<br/><br/>둘째 문단.'),
      item
    );
    const csv = gbPressReleasesToCsv([release]);
    expect(csv.split("\n")[0]).toContain("source_record_id");
    expect(csv).toContain('""인용""');
    expect(csv).toContain('"제목, 쉼표"');
  });
});

describe("Gyeongbuk press release crawler", () => {
  const outputDirectory = resolve(
    repositoryRoot,
    "pipelines/data/generated/gb-press-test"
  );

  const stubFetch = (pages: Record<number, string>): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      }
      if (url.searchParams.get("cmd") === "2") {
        const step = url.searchParams.get("B_STEP") ?? "";
        return new Response(
          detailHtml(`게시물 ${step}`, `2026-08-2${step.slice(-1)} 09:00:00`, `본문 ${step}.`),
          { status: 200 }
        );
      }
      const offset = Number(url.searchParams.get("Start") ?? "0");
      return new Response(pages[offset] ?? '<div class="report_list"></div>', {
        status: 200
      });
    }) as unknown as typeof fetch;

  it("stops walking offsets once a page predates the cutoff", async () => {
    await rm(outputDirectory, { recursive: true, force: true });
    const oldPage = `<div class="report_list"><ul>
${listItem(50, "2019년 발표", "19-12-30")}
</ul></div>`;
    const result = await crawlGbPressReleases({
      outputDirectory,
      since: "2020-01-01",
      termsAcknowledged: true,
      requestDelayMs: 0,
      concurrency: 2,
      now: () => new Date("2026-09-01T00:00:00Z"),
      fetchImpl: stubFetch({ 0: listHtml, 10: oldPage })
    });
    expect(result.releases).toHaveLength(2);
    expect(result.releases.map((row) => row.sourceRecordId).sort()).toEqual([
      "100",
      "99"
    ]);
    const csv = await readFile(
      resolve(outputDirectory, "경상북도_보도자료.csv"),
      "utf8"
    );
    expect(csv).toContain("게시물 100");
    await rm(outputDirectory, { recursive: true, force: true });
  });

  it("refuses to crawl without an explicit terms acknowledgement", async () => {
    await expect(
      crawlGbPressReleases({
        outputDirectory,
        since: "2020-01-01",
        requestDelayMs: 0,
        fetchImpl: stubFetch({ 0: listHtml })
      })
    ).rejects.toThrow(/termsAcknowledged/u);
  });
});
