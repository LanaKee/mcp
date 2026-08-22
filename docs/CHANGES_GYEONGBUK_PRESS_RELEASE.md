# 경상북도 보도자료 수집 및 서술적 맥락 제공

## 배경

기존 데이터셋은 인구·지방세·의회 안건·정책 PDF 등 **숫자와 표**가 중심이었다.
그래서 "왜 이 예산이 늘었는가", "이 사업의 정식 명칭이 무엇인가", "도가 어떤
계획을 발표했는가" 같은 **서술적 맥락**은 어디에도 없었다.

경상북도 보도자료 게시판(`gb.go.kr`, `mnu_uid=6792`, `BD_CODE=bbs_bodo`)은
도가 직접 발표한 공식 announcement이며, 정책 배경·사업명·추진 일정이 문장으로
적혀 있다. 이를 수집해 통계 데이터의 **해석 근거**로 붙인다.

## 가장 중요한 설계 결정: 보도자료는 통계 근거가 아니다

보도자료 본문에는 "500억 원 투입", "청년 1,000명 지원" 같은 숫자가 자주 등장한다.
이것은 **발표 시점의 계획치**이지 관측된 통계가 아니다. 집행 결과와 다를 수 있고,
이후 변경될 수도 있다.

따라서 보도자료는 의도적으로 fact/measure 모델 밖에 둔다.

| 통로 | 보도자료 사용 가능 여부 |
| --- | --- |
| `search_press_releases` | 가능 (서술적 맥락) |
| `verify_claim_with_data` | **불가**. 인구·지방세 정규화 팩트만 사용 |
| `compare_population_and_tax` 등 분석 도구 | **불가** |

이를 코드에서 강제하기 위해:

- 별도 테이블 `press_release`를 쓰고 `fact_*` 계열에 넣지 않는다.
- 행마다 `metadata.evidenceRole = "narrative_context_only"`를 기록한다.
- 검색 결과 `recordType`을 `"press_release"`로 고정한다.
- 도구 응답의 `result.evidence_role`과 `limitations`에 명시한다.

## 변경 요약

| 파일 | 역할 |
| --- | --- |
| `pipelines/src/crawl-http.ts` | 신규. 포항 크롤러에서 추출한 공용 HTTP 크롤 유틸 |
| `pipelines/src/gb-press-release.ts` | 신규. 목록/상세 파서 + 크롤 루프 |
| `pipelines/src/gb-press-release-cli.ts` | 신규. `gb:press:crawl` CLI |
| `pipelines/src/csv.ts` | `press_release` CSV kind 및 정규화 |
| `pipelines/src/etl.ts` | 보도자료 정규화 결과를 ETL 산출물에 포함 |
| `pipelines/src/load-plan.ts` | `press_release` 적재 계획, 언급 시군 추출, 본문 판독성 분류 |
| `pipelines/src/db.ts` | `press_release` upsert 및 무결성 집계 |
| `db/migrations/015_gyeongbuk_press_release.sql` | 신규 테이블 |
| `packages/domain/src/schemas.ts` | `pressReleaseSearchInputSchema` |
| `services/mcp-server/src/repository.ts` | `PressReleaseRepository` 인터페이스 |
| `services/mcp-server/src/postgres-repository.ts` | FTS + trigram 검색 구현 |
| `services/mcp-server/src/tools.ts` | `search_press_releases` 도구 |

## 크롤링에서 실제로 부딪힌 문제

### 1. 날짜 필터 파라미터가 무시된다

목록 URL은 `B_START` / `B_END` 날짜 파라미터를 받는 것처럼 보이지만, GET
요청에서는 **조용히 무시된다**. 값을 넣어도 항상 전체 게시물 첫 페이지가 온다.
(사이트는 `moveNext` POST 폼에서만 이 값을 쓴다.)

그래서 날짜로 범위를 좁히는 대신, 행 오프셋 `Start`를 10씩 늘려가며 걷고
**클라이언트에서 날짜로 잘라낸다**. 한 페이지가 전부 `since` 이전이면 중단한다.

측정한 아카이브 깊이:

| `Start` | 게시일 |
| --- | --- |
| 0 | 2026-08-21 |
| 5000 | 2024-09-04 |
| 10000 | 2022-11-10 |
| 13400 | 2020-12-03 |
| 13600 | 2020-04-17 |
| 14800 | (게시물 없음, 게시판 끝) |

2020-01-01 컷오프는 `Start ≈ 13,700` 부근이다.

### 2. 제목이 본문에 섞여 들어간 버그

상세 페이지 템플릿에는 제목이 한 번 더 들어 있는데, **HTML 주석**으로 감싸여 있다.

```html
<!--div class="view_title"> 제목 </div-->
```

태그 제거 정규식은 `<!--`로 시작하는 이 블록에 매칭되지 않으므로, 초기 구현에서는
**모든 기사 본문 맨 앞에 제목이 중복**되었다.

주석 제거 순서가 중요하다. `cont_view` 영역을 **먼저 잘라낸 뒤** 주석을 지운다.
반대로 하면 본문 끝을 알려주는 `<!-- 이전글다음글` 마커까지 사라져서 "이전글/다음글"
네비게이션 텍스트가 본문에 딸려 들어온다.

### 3. 두 자리 연도

목록 페이지의 날짜는 `26-08-21`처럼 두 자리 연도다. 상세 페이지에는 네 자리
`작성일`이 있으므로 `publishedDate`는 **상세 페이지를 우선**한다. 목록의 두 자리
연도는 크롤 중단 시점을 판단하는 힌트로만 쓰고, 미래로 확장되는 값은
`ambiguous`로 표시해 추측하지 않는다.

상세 페이지에 `작성일`이 없으면 목록 날짜로 대체하되
`missing_published_date` 품질 이슈를 남긴다.

### 4. 게시물 식별자

다운로드 링크가 쓰는 `B_STEP`이 게시물의 안정적인 id다(`B_NUM = B_STEP + 1`).
`V_NUM`은 행이 아니라 페이지 단위 파라미터로 보여 optional로 둔다.

`press_release_id`는 `gb-press-<B_STEP>`으로 만든다. 스냅샷 파일 해시가 아니라
게시판 자체의 id에서 나오므로, 나중에 다시 크롤해도 같은 발표가 **한 행으로
갱신**된다. (`MISTAKE_PATH_ADDRESSED_SOURCE_IDENTITY.md`에서 겪은 문제를 반복하지
않기 위한 선택이다.)

## 언급된 시군은 "관할"이 아니다

보도자료는 도가 발표하므로 `region_id`는 항상 `47`(경상북도)이다. 하지만 본문에
"청도군", "포항시" 같은 이름이 나오면 그 시군으로 검색할 수 있어야 유용하다.

그래서 `mentioned_region_ids`에 **본문에 등장한** 시군을 담되, 이것이 해당 시군의
사업이라는 뜻은 아님을 컬럼 주석·타입 주석·도구 `limitations` 세 곳에 명시했다.
단순 문자열 포함 검사이므로 오탐이 있을 수 있다.

## 판독 불가능한 본문은 검색에서 제외

`content_classification`이 `extracted_ok`가 아닌 행은 검색 쿼리에서 제외한다.
깨진 문자열을 "맥락"이라며 돌려주지 않기 위해서다. 판정 기준은 기존
`korean-text-quality` 규칙과 동일한 발상(치환문자 비율, 한글 비율)을 쓴다.

## 사용법

```bash
# 최신부터 2020-01-01까지 백필
pnpm gb:press:crawl --accept-terms --since=2020-01-01

# 증분 수집 (직전 결과를 재사용)
pnpm gb:press:crawl --accept-terms --since=2026-01-01

# 정규화 + 적재
pnpm process
```

`--accept-terms`는 필수다. 공개 사이트의 이용 조건을 사람이 확인했음을 명시적으로
표시하게 만든다. `robots.txt`는 매 실행마다 다시 확인한다
(현재 `User-agent: * / Allow: /`).

산출물은 `datasets/gyeongbuk-press-release/`에 쓰인다.

- `경상북도_보도자료.csv` — 적재 대상
- `gb_press_releases.json` — 첨부파일 목록·품질 이슈를 포함한 원본
- `gb_press_releases.metadata.json` — 수집 시각, 범위, 요청 수

## 테스트

- `pipelines/src/gb-press-release.test.ts` — 파서 10개 (주석 제목 누출, 두 자리
  연도, 첨부파일, CSV 이스케이프, 컷오프 중단, 약관 미승인 거부)
- `pipelines/src/csv.test.ts` — 헤더 기반 kind 판별
- `pipelines/src/load-plan.test.ts` — 재크롤 시 id 안정성, 언급 시군, 판독 불가 분류
- `services/mcp-server/src/tools.test.ts` — 도구 계약
- `services/mcp-server/src/press-release-search.integration.test.ts` — 실제 DB 검색
