# MCP 도구 명세

모든 도구 입력은 strict Zod object이므로 선언하지 않은 필드는 거절된다. 모든 출력은
`data_status`, `data_statuses`, `result`, `sources`, `limitations`를 갖는다. 아래 factual
도구는 선택 `dataStatuses` 배열로 `official_observed`/`demo_sample`을 제한할 수 있다.
기본은 둘 다이며 같은 연도/키가 충돌하면 공식 레코드를 우선한다.

## `get_population_trend`

- 입력: `region`, `startYear`, `endYear`, 선택 `dataStatuses`
- 출력: 연도별 인구(명), 절대 증감, 증감률, 방향

```json
{"region":"포항시","startYear":2022,"endYear":2024}
```

## `get_local_tax_revenue_trend`

- 입력: `region`, `startYear`, `endYear`, 선택 `taxCategory`, `dataStatuses`
- 출력: 회계연도별 지방세(원), 회계 기준, 증감
- 국세는 지원하지 않는다.

## `compare_population_and_tax`

- 입력: `startYear`, `endYear`, 선택 `regions`, `dataStatuses`
- 출력: 모든 비교 가능 지역과 `인구 감소 && 지방세 증가` 일치 지역
- 동시 변화는 인과관계가 아니다.

## `search_policies`

- 입력: `region`, `age`, `query`, 선택 `stage`, `asOfDate`, `dataStatuses`
- 출력: 정책별 `eligible`, 부합 이유, 미충족 조건, 점수
- 데모 정책은 실제 신청 자격을 의미하지 않는다.

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
- 출력: `consistent`/`inconsistent`, 기준값, 차이, 차이율

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
