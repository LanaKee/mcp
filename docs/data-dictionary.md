# 데이터 사전

## 공통 상태

| 값 | 의미 |
|---|---|
| `official_observed` | 제공된 원천 파일에서 파싱한 관측값. 원출처 재확인 필요 |
| `demo_sample` | 기능 테스트용 재배포 가능 예시. 공식 사실이 아님 |
| `catalog_only` | 파일 존재·해시·위치만 확인했고 본문/수치는 파싱하지 않음 |

## 핵심 테이블

### `dim_region`

| 컬럼 | 설명 |
|---|---|
| `region_id` | canonical 행정구역 키 |
| `region_name` | 표시 명칭 |
| `region_type` | province/city/county/district/town |
| `parent_region_id` | 상위 행정구역 |
| `normalized_name` | 공백·접두어 정규화 명칭 |

현재 canonical 집합은 경상북도 1개와 군위군 전출 이후의 22개 시·군이다. 파일명,
`경북`, `경북도`, `경북도의회`, 시·군 의회 명칭 등의 alias를 같은 키로 해석한다.

### `data_source`

출처 제목, 제공기관, URL, 라이선스, 원본 상대경로, SHA-256, 수집시각, 기준일,
미디어 형식, 공식 여부와 `data_status`를 보관한다. `source_key`는 원본 경로와
SHA-256을 포함하므로 같은 경로의 파일이 변경되어도 이전 버전을 덮어쓰지 않는다.

### `ingestion_run`

파이프라인명·버전, 시작/종료, 상태, 입력 해시, insert/update/error 수와 오류 보고서를
기록한다. 같은 입력 해시의 재실행 여부를 판단할 수 있다. 정책과 의회 레코드도
`ingestion_run_id`를 보관한다.

### `population_observation`

지역·정확한 기준일별 총인구, 성별 인구, 세대수, 외국인 수, 출처와 원본 행 번호를
저장한다. 포항 CSV의 `년월`은 일자까지 유지하고, 2026년 7월 XLSX는 월말인
`2026-07-31`로 저장한다. 샘플 CSV의 `population_total` 단위는 명이다.

### `local_tax_revenue`

지역·회계연도·세목별 도구용 headline 지방세 금액(원)을 저장한다. **국세는 범위
밖**이다. 공식 원천과 기존 가상 샘플을 함께 보존하되 repository는 같은
지역·연도·세목에서 공식을 우선한다.

| 컬럼 | 설명 |
|---|---|
| `accounting_basis` | `settlement`, `reported`, 기존 sample의 `budget` |
| `amount_semantics` | `collected_amount`, `payment_amount`, `reported_total_tax_burden`, sample의 `demo_settlement`, 기존 행의 `legacy_unspecified` |
| `source_grain` | `collection_status`, `payment_media`, `per_capita_burden`, `demo_sample`, 기존 행의 `legacy_unspecified` |
| `unit_original` / `unit_multiplier` | 원천 `KRW`/`thousand_KRW`와 KRW 변환 배수 1/1,000 |
| `unit_provenance` | 명시 원/천원 header, 무표기 원 기본, cross-source 천원 reconciliation |
| `is_aggregate` | 합계/총계/소계/계 행 또는 검증된 detail 합산 여부 |
| `source_row` / `metadata` | 원본 행과 파생에 사용한 행 목록 등 |

headline 선택 우선순위는 징수현황의 수납액, 징수현황이 없는 지역·연도의
1인당 부담 원천 지방세 총액, 징수 세목이 없는 납부현황 세목 합계다. 서로 다른 의미를
하나의 숫자로 강제하지 않고 위 컬럼으로 노출한다.

### 지방세 원천 grain

모든 행은 `official_observed`, canonical `region_id`, source SHA/version,
`source_row`, `ingestion_run_id`, KRW 변환 provenance를 가진다.

| 테이블 | grain / 주요 값 |
|---|---|
| `local_tax_collection_status` | 지역·연도·세목별 부과, 수납, 환급, 결손/정리보류, 미수납, 신고/계산 징수율 |
| `local_tax_payment_media` | 지역·연도·세목·납부매체·전자고지별 건수/납부액/비율 |
| `local_tax_assessment_status` | 지역·연도·세목별 과세/비과세 건수와 금액; 원천 blank는 NULL |
| `local_tax_per_capita_burden` | 지역·연도별 주민/세대당 부담, 지방세 총액, 선택 인구/세대수 |
| `local_tax_taxpayer_status` | 지역·연도·세목·납세자유형·관내외별 납세자 수 |
| `local_tax_exemption_status` | 지역·연도·세목별 비과세/감면/부과 금액과 신고/계산 비율 |
| `local_tax_unrefunded_status` | 지역·연도·세목·미환급유형·납세자유형별 당해/누적 건수·금액 |
| `local_tax_enforcement_statistic` | 지역·영치일·기관별 체납 건수/금액; 영치장소 문자열은 미저장 |

예천의 두 자리 연도는 00~99를 20YY로 확장한 뒤 2000~실행연도+1 범위를 다시
검증한다. 영천 비과세·감면 720행은 `세액`/`건수` 규모가 열 의미와 모순되어 값을
교환하지 않고 격리했다. 김천 일반건축물 40,694 data row는 주소 단위 microdata이므로
catalog에만 governance 결정을 남기고 일반 fact/search/embedding에 적재하지 않았다.

### `data_quality_issue`

source/row/field별 결정적 issue key, severity, 관측/기대값, quarantine 여부와 ingestion
run을 저장한다. 현재 검사는 단위 판정, 연도 범위, canonical code/name 일치, 음수/잘못된
숫자, zero-only, 징수율 재계산, natural-key 중복, aggregate/detail 합계, 부분 blank,
검증되지 않은 열 의미와 개인정보 제외 결정을 포함한다. 공개 응답에 원본 주소나 영치
장소를 복사하지 않는다.

### `policy_program`

지역, 정책명, 주관기관, 최소/최대 나이, 산업, 창업 단계, 자격 설명, 지원 내용,
신청기간과 원출처를 저장한다.

### `council_record`

의회, 회기, 회의일, 안건번호, 제목, 발의자, 처리결과와 출처를 저장한다.

### `document`

정책·회의록·첨부문서의 source, 기관, 날짜, extraction 상태, page 수와 전체 cleaned
content hash를 저장한다.

- `document_key`와 UUID는 source version에서 결정적으로 생성한다.
- `extraction_status`: `extracted`, `partial`, `ocr_required`, `extraction_failed`,
  `password_required`

### `document_page`

페이지 본문 자체를 중복 저장하지 않고 extraction/provenance와 품질 지표를 저장한다.
현재 extractor version별 `page_key`/UUID가 결정적이며 같은 문서·페이지에는
`is_current = true`가 하나만 허용된다.

| 컬럼 | 설명 |
|---|---|
| `raw_content_sha256` | PDF.js item reconstruction 직후 원문 text hash |
| `content_sha256` | 공백·장식·고신뢰 반복 margin 정리 후 text hash |
| `extractor_version` | layout/정리 규칙 버전 |
| `non_whitespace_character_count` | cleaned text의 공백 제외 Unicode 문자 수 |
| `hangul_ratio` | cleaned 공백 제외 문자 중 한글 음절/자모 비율 |
| `replacement_control_glyph_ratio` | raw 공백 제외 문자 중 replacement/control/private-use 비율 |
| `suspicious_spacing_ratio` | 단일 한글 토큰이 과도하게 분리된 문자 비율 |
| `repeated_header_line_count` / `repeated_footer_line_count` | 해당 페이지에서 제거한 반복 margin 줄 수 |
| `likely_table_line_count` / `likely_table_density` | tab/숫자 cell/leader 기준 표 유사 줄 수와 비율 |
| `speaker_marker_count` | `○`로 시작하는 한국어 의회 발언자 전환 수 |
| `text_class` | `empty`, `near_empty`(<80자), `substantive` |
| `error_text` | page extraction 실패의 bounded 오류 |
| `metadata` | 제거한 margin 원문이 아닌 line hash, 품질 flag, source path |

### `document_chunk`

검색 단위 cleaned text와 page provenance를 저장한다.

- `chunk_key`/UUID는 source version·chunker version·페이지·페이지 내 순번에서 결정적으로 생성한다.
- 발언자 turn은 원자적으로 유지하고 chunk 절단은 발언자 전환에서만 수행한다.
- tab/leader 기반 table-like 연속 행은 줄바꿈을 유지한 하나의 segment로 취급한다.
- `page_start`, `page_end`, raw/cleaned page hash metadata가 provenance를 보존한다.
- `processing_version_key`는 extractor/chunker lifecycle 행을 가리킨다.
- `is_current = false`인 chunk는 삭제하지 않은 과거 추출 결과이며 검색에서 제외한다.
- `approved_current`는 approved production version과 함께 검색 partial index에 쓰인다.
- `created_at`/`stale_at`은 최소 보존기간과 purge cutoff 기준이다.
- 기존 `document_chunk.embedding_*`/`embedding_data` 컬럼은 호환용이며 새 적재기는 쓰지 않는다.

### `pdf_processing_version`

extractor/chunker 조합의 승인 상태와 운영 변경 이력을 보관한다.

| 컬럼 | 설명 |
|---|---|
| `version_key` | `extractor_version::chunker_version` 식별자 |
| `approval_state` | `candidate`, `approved`, `retired` |
| `activated_*` | 승인/rollback 시각, actor, 이유 |
| `retired_*` | retirement 시각, actor, 이유 |
| `metadata` | seed/등록 등 bounded 운영 메타데이터 |

partial unique index는 approved 행을 하나로 제한한다. 첫 기존 current corpus는 migration
007에서 approved로 보존되고 이전 output은 `retired`로 분류된다.

### `pdf_processing_version_event`

`seed`, `approve`, `rollback`, `retire` 변경을 actor/reason/시각과 함께 append-only로
기록한다.

### `document_processing_version`

base `document` provenance와 별개로 문서별 processing version의 extraction 상태,
page 수, content hash, ingestion run과 stale 시각을 보관한다. purge는 이 version 행을
정리하되 아직 source/fact가 참조하는 base `document`와 `data_source`를 광범위 삭제하지
않는다.

### `document_chunk_embedding`

chunk, provider, model, version별 임베딩을 저장한다. `embedding`은 `real[]`이고
`cardinality(embedding) = dimensions` check가 있다. provider 차원이 달라질 수 있어 단일
고정차원 pgvector 컬럼 대신 별도 테이블을 사용했다.

| 컬럼 | 설명 |
|---|---|
| `provider` / `model` / `model_version` | 생성기 식별 |
| `dimensions` | 벡터 차원 |
| `retrieval_mode` | `semantic` 또는 `lexical_hash` |
| `embedding` | PostgreSQL `real[]` 벡터 |
| `content_sha256` | 어떤 chunk 내용으로 생성했는지 확인 |
| `metadata` | 결정성, retrieval-only 경고 등 |

### `source_locator`

엔터티 키를 원본 페이지, 행, 절, 문자 범위 또는 사람이 읽을 수 있는 locator와
연결한다. 현재 적재기는 공식/데모 인구, 의회 레코드, 공식 지방세 각 grain/headline의
행 위치, PDF document/page/current chunk locator를 기록한다. repository는 stale
page/chunk locator를 source context에서 제외한다.

### `mcp_tool_audit`

PostgreSQL repository에서 실행된 MCP/HTTP 도구 호출의 bounded 운영 메타데이터를
90일 만료 시각과 함께 저장한다.

| 컬럼 | 설명 |
|---|---|
| `tool_name` | 목적별 도구 이름 |
| `started_at` / `finished_at` / `duration_ms` | 실행 시각과 지연 |
| `success` / `error_class` | 성공 여부와 일반 오류 클래스 |
| `data_statuses` | 응답에 실제 포함된 상태 배열 |
| `result_count` | 응답 형태에서 계산한 bounded 결과 수 |
| `request_hash` | process salt + 도구명 + canonical input의 SHA-256 |
| `request_metadata` | raw 값이 아닌 필드명, 타입, 문자열/배열 길이 |
| `correlation_id` | strict inbound 또는 생성된 HTTP `X-Request-ID`; stdio는 NULL 가능 |
| `repository_mode` | `memory` 또는 `postgres` |
| `expires_at` | 기본 `created_at + 90 days`; 운영 purge 기준 |

감사 쓰기는 best-effort다. 실패는 구조화 경고로 남지만 성공한 read-only query를
실패로 바꾸지 않는다.

### `mcp_tool_audit_daily`

만료 audit를 삭제하기 전에 날짜·도구·성공 여부·repository mode별 호출 수,
result/duration 합과 최대 지연을 보존한다. raw request/hash/correlation ID는 aggregate에
복사하지 않는다.

### `storage_maintenance_run`

stale/audit purge plan과 ANALYZE/VACUUM 실행을 기록한다. `planned`, `running`,
`partial`, `succeeded`, `failed` 상태, exact `plan_token`, retention, candidate count/hash,
논리 byte 추정, batch 결과와 bounded 오류를 가진다. `partial` plan은 같은 token으로
재개할 수 있고 candidate가 달라지면 새 dry-run이 필요하다.

## 샘플 파일

| 파일 | 범위 | 상태 |
|---|---|---|
| `population.csv` | 포항·상주·김천·구미, 2022~2024 | `demo_sample` |
| `local-tax.csv` | 위 시군 지방세 합계 가상 결산값 | `demo_sample` |
| `policies.json` | 상주/경북 스마트팜 가상 정책 3건 | `demo_sample` |
| `council-records.json` | 2020~2024 지방소멸 가상 요약 | `demo_sample` |
| `sources.json` | 샘플 출처와 비공식 경고 | `demo_sample` |
