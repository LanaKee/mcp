# MCP 도구 명세

모든 도구 입력은 strict Zod object이므로 선언하지 않은 필드는 거절된다. 모든 출력은
`data_status`, `data_statuses`, `result`, `sources`, `limitations`를 갖는다. 아래 factual
도구는 선택 `dataStatuses` 배열로 `official_observed`/`demo_sample`을 제한할 수 있다.
기본은 둘 다이며 같은 연도/키가 충돌하면 공식 레코드를 우선한다.
목록 반환과 파생 결론은 별개다. point는 삭제하지 않지만 비교 가능성 조건을 통과하지
못하면 `summary`/verdict를 생성하지 않는다.

## `get_population_trend`

- 입력: `region`, `startYear`, `endYear`, 선택 `dataStatuses`
- 출력: 연도별 인구(명), nullable summary, `summary_unavailable_reason`,
  `measurementBasis`, `referenceDatePrecision`, homogeneous `series_segments`
- 상태·측정기준·날짜 정밀도가 섞이거나 point가 한 건이면 전체 증감률을 계산하지
  않는다. 과세연도 보고 인구의 `12-31`은 실제 snapshot 날짜가 아니라 period key다.

```json
{"region":"포항시","startYear":2022,"endYear":2024}
```

## `get_local_tax_revenue_trend`

- 입력: `region`, `startYear`, `endYear`, 선택 `taxCategory`, `dataStatuses`
- 출력: 회계연도별 지방세(원), 개별 `dataStatus`, 회계 기준,
  `amountSemantics`, `sourceGrain`, 원단위/배수와 증감
- 같은 지역·연도·세목에 공식과 샘플이 모두 있으면 공식만 선택한다.
- 공식 합계에서 `collection_status`가 도세+시·군세 결합 범위이면 headline에서
  제외하고 `statistical_yearbook_local_collection`의 시·군세 소계를 사용한다.
- 일부 연도만 공식인 추세는 각 point 상태와 limitation을 명시하며 상태가 다른 값을
  합산하지 않는다. 상태·회계기준·금액 의미·grain·원단위/배수 중 하나라도 다르면
  `summary: null`, `incomparable_sources`다.
- 한 점뿐이면 `summary: null`, `insufficient_points`다. segment 내부의 별도 summary는
  해당 compatibility metadata와 함께 제공한다.
- 국세는 지원하지 않는다.

## `compare_population_and_tax`

- 입력: `startYear`, `endYear`, 선택 `regions`, `dataStatuses`
- 출력: 비교 가능한 공식 지역의 `matches`, 평가 불가능 지역의 `not_evaluable`,
  전체 nullable 결과 `all_regions`
- 각 지역 결과는 `populationDataStatuses`, `taxDataStatuses`,
  `populationMeasurementBases`, `taxAmountSemantics`, `taxSourceGrains`를 포함한다.
- 공식 지방세가 있는 지역·연도는 공식 값을 사용하며 sample-only/mixed 구간을
  limitation에서 명시한다.
- endpoint 누락, 혼합 source, demo가 한쪽이라도 있으면 `evaluable: false`,
  `matches: null`이며 방향/상관 style verdict를 만들지 않는다.
- 동시 변화는 인과관계가 아니다.

## `search_policies`

- 입력: `region`, `age`, `query`, 선택 `stage`, `asOfDate`, `dataStatuses`
- 출력:
  - `matches`: 구조화 정책별 `eligible`, 부합 이유, 미충족 조건, 점수
  - `official_document_passages`: 공식 도정 업무계획의 title, page, locator,
    `documentType`, `extractionMethod`, passage
  - 특정 연도를 요청하면 `policy_document_coverage`: source 존재 여부, machine-readable
    검색 가능 여부, content classification과 제외 이유
- 현재 `matches`의 정책 자격은 `demo_sample` 기능 예시다. 공식 passage를 이 verdict에
  합치거나 신청 자격으로 변환하지 않는다.
- 공식 passage는 `provincial_work_plan` 중 승인된 current chunk와
  `content_classification=extracted_ok`만 검색한다. mojibake/unusable page는
  반환되지 않는다.
- 2020·2022·2024를 지정하면 원문 source는 존재하지만 기계 판독 가능한 본문이
  없다고 명시하며 정책 coverage를 암시하지 않는다.

```json
{"region":"상주시","age":34,"query":"스마트팜","stage":"예비창업"}
```

## `search_council_records`

- 입력: `query`, 선택 `region`, `council`, `dateFrom`, `dateTo`, `limit`,
  `dataStatuses`
- 출력: 제목/본문/메타데이터와 lexical/hybrid 점수
- 한글 NFC 정규화, 단어·bi-gram·부분문자열을 사용한다.
- PostgreSQL 모드는 구조화 `council_record`와 현재 PDF `document_chunk`를 결합한다.
- PDF hit는 `recordType`, `pageStart`, `pageEnd`, `locator`, source ID를 포함한다.
- `PostgresHybridSearchRepository`는 FTS/trigram 후보와 저장 embedding cosine 점수를
  결합한다.

## `verify_claim_with_data`

- 입력: `metric`(`population`/`local_tax`), `region`, `year`,
  `claimedValue`, 선택 `tolerancePercent`, `dataStatuses`
- 출력: 공식 기준이면 `consistent`/`inconsistent`, demo 기준이면
  `not_verifiable`과 `demo_data_not_evidence`
- 지방세 검증은 기준값의 `accounting_basis`, `amount_semantics`,
  `source_grain`, record 상태를 함께 반환한다.

## `get_source_context`

- 입력: `sourceIds` 배열
- 출력: 찾은 출처와 누락 ID, source version alias, 최대 source당 50개 locator.
  PostgreSQL PDF source는 현재 extractor/chunker의 page/chunk locator와 최대 1,000자
  excerpt를 반환하며 `is_current = false`인 과거 locator는 제외한다.

## `draft_public_document`

- 입력: 문서 종류, 제목, 선택 요청자 문맥, `verifiedAnalysis`
- 문서 종류: `information_request`, `participatory_budget`
- `verifiedAnalysis`는 결론, 출처가 연결된 근거, 출처 묶음, 한계,
  `verified: true`를 포함해야 한다.
- 근거의 source ID가 출처 묶음에 없으면 실패한다.
- demo 또는 비공식 source가 포함되면 공공문서 검증 근거로 거절한다.
- 출력은 항상 **검토가 필요한 초안**으로 표시한다.

## 오류

MCP 오류는 `isError: true` content로 반환한다. stdio는 local transport이므로 HTTP
token/rate limit을 적용하지 않는다.

HTTP `/api/**`는 설정 시 bearer/API token을 요구하고 다음 상태를 구분한다.

- `400`: JSON/입력 shape 검증 실패
- `401`: token 누락/불일치
- `404`/`405`: 고정 route/tool/method allowlist 위반
- `413`/`415`: body 크기/content type 위반
- `422`: 안전하게 표시 가능한 처리 불가
- `429`: rate limit, `Retry-After` 포함
- `503`/`504`: DB/operation availability 또는 timeout

오류 body는 code, 일반화된 message, `request_id`만 포함해 내부 오류/환경 변수를
노출하지 않는다. 모든 HTTP 응답에는 security header와 `X-Request-ID`가 있다.
PostgreSQL audit에는 raw query 대신 hash/shape와 동일 correlation ID를 저장한다.

## 운영용 저장공간 API

`GET /api/admin/storage`는 일반 MCP 도구가 아니라 token mode에서만 허용되는 HTTP 운영
endpoint다. current/stale chunk·embedding·page 수, DB/relation 크기, 만료 audit 수,
processing version 상태와 `shared_buffers`, `maintenance_work_mem` 등 안전한 설정만
반환한다. 연결 문자열·token·raw 요청은 반환하지 않는다. `HTTP_AUTH_MODE=off`에서는
로컬이어도 `403`이며, 공개 `/ready`는 상세 용량/설정을 노출하지 않는다.
