import { describe, expect, it } from "vitest";
import {
  gbCouncilBillsToCsv,
  gbCouncilMembersToCsv,
  gbCouncilSponsorsToCsv,
  inferBillKind,
  normalizeCouncilDate,
  parseGbCouncilBillDetail,
  parseGbCouncilBillList,
  parseGbCouncilRoster,
  type GbCouncilBill
} from "./gb-council.js";

const rosterHtml = `
<html><body>
<div class="profile">
  <dl>
    <dt><img src="/attach/member/PR_13/abc.png" alt="김대진" /></dt>
    <dd>
      <div class="name"><strong>김대진</strong>
        <div class="sns"><a href="#" class="fb off">페이스북</a></div>
      </div>
      <ul class="dot">
        <li><em>직        위</em><span class="colon">:</span><span>문화환경위원회 위원장</span></li>
        <li><em>선  거  구</em><span class="colon">:</span><span>안동시 제1선거구  </span></li>
        <li><em>소속정당</em><span class="colon">:</span><span>국민의힘</span></li>
      </ul>
    </dd>
  </dl>
  <div class="btns">
    <a href="#pop852" id="btn_profile852" class="btn_profile start">프로필보기</a>
    <a href="/member/main?search_code=12009" class="end">누리집 바로가기</a>
  </div>
</div>
<div class="profile none">
  <dl>
    <dt><img src="/attach/member/PR_13/def.png" alt="공승희" /></dt>
    <dd>
      <div class="name"><strong>공승희</strong></div>
      <ul class="dot">
        <li><em>직        위</em><span class="colon">:</span><span>문화환경위원회 위원</span></li>
        <li><em>선  거  구</em><span class="colon">:</span><span>비례대표</span></li>
        <li><em>소속정당</em><span class="colon">:</span><span>국민의힘</span></li>
      </ul>
    </dd>
  </dl>
  <div class="btns">
    <a href="#pop897" id="btn_profile897" class="btn_profile start">프로필보기</a>
    <a href="/member/main?search_code=13640" class="end">누리집 바로가기</a>
  </div>
</div>
<div id="pop852"><p>이 름</p><p>김대진</p><p>사 무 실</p><p>054-880-5360</p>
  <p>&lt;학력사항&gt;</p><p>안동대학교 졸업</p>
  <p>&lt;경력사항&gt;</p><p>(현)제13대 경상북도의회 문화환경위원회 위원장</p><p>(전)안동시의회 의원</p>
</div>
<div id="pop897"><p>이 름</p><p>공승희</p><p>사 무 실</p><p>054-880-5368</p>
  <p>&lt;학력사항&gt;</p><p>김천간호전문대학 졸업</p>
  <p>&lt;경력사항&gt;</p><p>(전)경상북도 김천의료원 간호부장</p>
</div>
<div id="footer">끝</div>
</body></html>`;

const billListHtml = `
<table class="board_list bbs_bill">
<thead><tr><th>의안번호</th><th>의안명</th></tr></thead>
<tbody>
<tr>
  <td class="num">1327</td>
  <td class="con"><a href="?reform=view&uid=aa11bb22cc33dd44ee55ff6677889900&page=1&search_code=12009">경상북도 기업 및 투자유치촉진 조례 일부개정조례안</a></td>
  <td class="author author1">의원</td>
  <td class="author author2">기획경제위원회</td>
  <td class="date date1"><span title="2026-03-11">2026-03-11</span></td>
  <td class="state">처리완료</td>
  <td class="date date2">2026-03-20</td>
</tr>
<tr><td colspan="7">검색결과가 없습니다.</td></tr>
</tbody>
</table>`;

const billDetailHtml = `
<table><caption>의안처리현황 진행단계를 보여줍니다.</caption>
<tbody><tr><td>접수</td></tr></tbody></table>
<table><caption>해당 의안의 대표발의자와 공동발의자 명단을 제공하는 표입니다.</caption>
<tr><th>대표발의자</th><td>도희재</td></tr>
<tr><th>공동발의자</th><td>연규식</td><td>김상백</td><td>공승희</td></tr>
</table>
<table><caption>의안 접수상태, 각 항목은 의안번호, 접수일자, 제안회기, 제안자, 의안원문으로 구분됨</caption>
<tr><th>의안번호</th><th>접수일자</th><th>제안회기</th><th>제안자</th><th>의안원문</th></tr>
<tr><td>12</td><td>2026-07-16</td><td>제364회 경상북도의회 임시회</td><td>의원</td><td>의안원문</td></tr>
</table>
<table><caption>위원회 심사정보, 각 항목은 소관위원회, 회부일, 상정일, 처리일, 처리결과, 보고문서로 구분됨</caption>
<tr><th>소관위원회</th><th>회부일</th><th>상정일</th><th>처리일</th><th>처리결과</th><th>보고문서</th></tr>
<tr><td>의회운영위원회</td><td></td><td></td><td></td><td>원안가결</td><td></td></tr>
</table>
<table><caption>본회의 회의정보, 각 항목은 회의명, 상정일, 의결일, 처리결과, 회의록으로 구분됨</caption>
<tr><th>회의명</th><th>상정일</th><th>의결일</th><th>처리결과</th><th>회의록</th></tr>
<tr><td></td><td>2026-07-16</td><td>2026-07-18</td><td>원안가결</td><td></td></tr>
</table>`;

describe("Gyeongbuk council roster parsing", () => {
  it("reads every member card once, joining the profile popup by its id", () => {
    const members = parseGbCouncilRoster(rosterHtml);
    expect(members.map((member) => member.name)).toEqual(["공승희", "김대진"]);
    const kim = members.find((member) => member.name === "김대진")!;
    expect(kim.searchCode).toBe("12009");
    expect(kim.siteMemberId).toBe("852");
    expect(kim.party).toBe("국민의힘");
    expect(kim.district).toBe("안동시 제1선거구");
    expect(kim.position).toBe("문화환경위원회 위원장");
    expect(kim.officePhone).toBe("054-880-5360");
    expect(kim.education).toBe("안동대학교 졸업");
    expect(kim.career).toContain("(전)안동시의회 의원");
    expect(kim.photoUrl).toBe(
      "https://council.gb.go.kr/attach/member/PR_13/abc.png"
    );
  });

  it("does not leak one member's career into the next card", () => {
    const members = parseGbCouncilRoster(rosterHtml);
    const gong = members.find((member) => member.name === "공승희")!;
    expect(gong.career).toBe("(전)경상북도 김천의료원 간호부장");
    expect(gong.education).toBe("김천간호전문대학 졸업");
  });
});

describe("Gyeongbuk council bill list parsing", () => {
  it("reads the seven-column row and drops the empty-result placeholder", () => {
    const rows = parseGbCouncilBillList(billListHtml);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      billUid: "AA11BB22CC33DD44EE55FF6677889900",
      billNumber: "1327",
      proposerKind: "의원",
      committee: "기획경제위원회",
      proposedDate: "2026-03-11",
      status: "처리완료",
      decidedDate: "2026-03-20"
    });
  });
});

describe("Gyeongbuk council bill detail parsing", () => {
  it("keeps 대표발의 separate from 공동발의", () => {
    const detail = parseGbCouncilBillDetail(billDetailHtml);
    expect(detail.leadSponsors).toEqual(["도희재"]);
    expect(detail.coSponsors).toEqual(["연규식", "김상백", "공승희"]);
  });

  it("reads captioned tables by caption, not by position", () => {
    const detail = parseGbCouncilBillDetail(billDetailHtml);
    expect(detail.session).toBe("제364회 경상북도의회 임시회");
    expect(detail.proposedDate).toBe("2026-07-16");
    // The committee tables carry no <tbody>, which an earlier version silently
    // read as "no rows".
    expect(detail.committee).toBe("의회운영위원회");
    expect(detail.outcome).toBe("원안가결");
    expect(detail.decidedDate).toBe("2026-07-18");
  });

  it("returns empty sponsor lists rather than throwing on a stub page", () => {
    const detail = parseGbCouncilBillDetail("<html><body>없음</body></html>");
    expect(detail.leadSponsors).toEqual([]);
    expect(detail.coSponsors).toEqual([]);
    expect(detail.session).toBeNull();
  });
});

describe("Gyeongbuk council value helpers", () => {
  it("normalises the site's date renderings and rejects junk", () => {
    expect(normalizeCouncilDate("2026-07-16")).toBe("2026-07-16");
    expect(normalizeCouncilDate("2026.7.6")).toBe("2026-07-06");
    expect(normalizeCouncilDate("")).toBeNull();
    expect(normalizeCouncilDate("미정")).toBeNull();
  });

  it("infers the bill category from the printed title", () => {
    expect(inferBillKind("경상북도 개인정보 보호 조례안")).toBe("조례안");
    expect(inferBillKind("공무원 출석요구의 건")).toBeNull();
  });
});

describe("Gyeongbuk council CSV rendering", () => {
  const bill: GbCouncilBill = {
    billUid: "AA11BB22CC33DD44EE55FF6677889900",
    billNumber: "1327",
    title: '경상북도 "청년" 조례안, 개정',
    proposerKind: "의원",
    committee: "기획경제위원회",
    proposedDate: "2026-03-11",
    decidedDate: "2026-03-20",
    status: "처리완료",
    outcome: "원안가결",
    session: "제360회",
    billKind: "조례안",
    leadSponsors: ["김대진"],
    coSponsors: ["공승희", "도희재"],
    detailUrl: "https://council.gb.go.kr/member/bill/contents?reform=view",
    listedForSearchCodes: ["12009"]
  };

  it("quotes commas and doubles embedded quotes", () => {
    const csv = gbCouncilBillsToCsv([bill]);
    expect(csv.split("\n")[1]).toContain('"경상북도 ""청년"" 조례안, 개정"');
    expect(csv).toContain(",조례안,");
  });

  it("emits one sponsor row per role so the join stays lossless", () => {
    const csv = gbCouncilSponsorsToCsv([
      { billUid: bill.billUid, role: "lead", memberName: "김대진", searchCode: "12009" },
      { billUid: bill.billUid, role: "co", memberName: "공승희", searchCode: null }
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("bill_uid,role,member_name,search_code");
    expect(lines[1]).toContain(",lead,김대진,12009");
    expect(lines[2]).toBe(`${bill.billUid},co,공승희,`);
  });

  it("keeps multi-line career text inside one CSV field", () => {
    const csv = gbCouncilMembersToCsv(parseGbCouncilRoster(rosterHtml));
    expect(csv).toContain('"(현)제13대 경상북도의회 문화환경위원회 위원장');
    expect(csv.split("\n")[0]).toContain("search_code,site_member_id,name");
  });
});
