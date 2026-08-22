# 경북 데이터 나침반

경상북도와 시·군의 인구·지방세·정책·의회 데이터를 **목적별 MCP 도구**로
조회하고, 결론·근거·출처·한계를 함께 보여 주는 해커톤용 vertical slice입니다.

> [!WARNING]
> `data/sample/`의 인구·지방세·정책·의회 값은 `demo_sample`인 기능 시연용이다.
> `datasets/`에서 파싱한 값만 `official_observed`이며, 이 값도 원출처와 기준일을
> 확인한 뒤 사용해야 한다. 공식 지방세가 있는 지역·연도는 샘플보다 우선하며, 없는
> 구간만 응답에 `demo_sample`로 명시된다.

## 구현 범위

- 반응형 한국어 웹 UI와 대표 질문 4개
- 공식 `@modelcontextprotocol/sdk` 기반 stdio MCP 서버
- 같은 도구를 호출하는 HTTP API와 데모 오케스트레이션
- 인구·지방세 추세, 교차 비교, 정책 자격 설명, 의회 검색, 주장 검증, 출처 조회,
  근거 제한형 행정문서 초안 등 8개 도구
- NFD 파일명에 의존하지 않고 헤더/내용으로 판별하는 CP949·UTF-8 CSV 및 XLSX ETL
- 9개 지방세 원천 grain의 KRW 단위 정규화, 품질 검증, 격리와 공식 우선 조회
- 제공된 CSV·PDF·XLSX 전체의 SHA-256 카탈로그 생성
- PDF.js 기반 401개 회의록/감사 PDF 페이지 추출, chunk, 로컬 임베딩 적재
- page-level 품질 지표, 반복 머리말 제거, 발언자/표 경계 chunk와 golden 회귀 평가
- 승인된 PDF 처리 version만 검색하는 lifecycle, 보존기간·확인 token 기반 purge와 용량 보고
- PostgreSQL 정규화 스키마, 마이그레이션, Docker Compose
- 한글 FTS/trigram과 저장 임베딩을 결합하는 PostgreSQL hybrid repository
- feature flag 기반 PostgreSQL MCP repository, readiness, redacted 도구 감사 로그
- Vitest 기반 도메인·검색·ETL·도구·HTTP 테스트

## 빠른 시작

요구사항: Node.js 22 이상, pnpm 10 이상

```bash
pnpm install
pnpm test
pnpm build
pnpm start
```

브라우저에서 <http://localhost:8787>을 엽니다.
`DATA_REPOSITORY=auto`가 기본이며 `DATABASE_URL`이 있으면 PostgreSQL, 없으면
명시적 데모 메모리 저장소를 사용한다. `.env`는 서버가 자동으로 읽는다. 로컬 HTTP
인증 기본은 `HTTP_AUTH_MODE=off`이며 외부에 노출해서는 안 된다.
서버 bind 기본도 `HTTP_HOST=127.0.0.1`이며 Docker만 명시적으로 `0.0.0.0`을 사용한다.

개발 모드:

```bash
pnpm dev
```

### Docker

```bash
HTTP_AUTH_TOKEN="$(openssl rand -hex 32)" docker compose up --build
```

- 웹/API: <http://localhost:8787>
- PostgreSQL: `localhost:5432`
- 초기 스키마: `db/schema.sql`

Compose는 `HTTP_AUTH_MODE=token`을 강제하며 token이 없으면 시작하지 않는다. 운영
배포는 TLS를 종료하는 reverse proxy 뒤에 두고 token은 secret manager/배포 secret으로
주입해야 한다. 저장소에 token을 기록하지 않는다.

기존 PostgreSQL에 마이그레이션을 적용하려면:

```bash
pnpm db:schema
```

`DATABASE_URL`은 환경변수 또는 저장소의 `.env`에서 읽으며 명령 출력에 연결 문자열을
노출하지 않습니다.

## MCP stdio 설정

먼저 `pnpm install && pnpm build`를 실행한 뒤 MCP 클라이언트에 다음과 같이 등록합니다.

```json
{
  "mcpServers": {
    "gyeongbuk-public-ai": {
      "command": "node",
      "args": [
        "/absolute/path/to/gyeongbuk-public-ai/services/mcp-server/dist/index.js",
        "--stdio"
      ]
    }
  }
}
```

개발 중에는 다음 명령으로 stdio 서버를 직접 실행할 수 있습니다.

```bash
pnpm --filter @gb/mcp-server dev:stdio
```

서버는 stdout을 JSON-RPC 전용으로 사용합니다.
HTTP 인증·rate limit 설정은 local stdio transport에 적용되지 않는다.

## HTTP API

| 방식 | 경로 | 설명 |
|---|---|---|
| `GET` | `/health` | 프로세스 생존 확인 |
| `GET` | `/ready` | 최소 ready/not-ready 상태만 공개 |
| `GET` | `/api/questions` | 대표 질문 목록 |
| `GET` | `/api/admin/storage` | token 전용 DB 용량·lifecycle·안전한 설정 요약 |
| `POST` | `/api/demo` | 대표 질문 ID 실행 |
| `POST` | `/api/tools/:toolName` | MCP와 동일한 도구 함수 실행 |

```bash
curl http://localhost:8787/health

export HTTP_AUTH_TOKEN="$(openssl rand -hex 32)"
HTTP_AUTH_MODE=token pnpm start

curl -X POST http://localhost:8787/api/demo \
  -H "authorization: Bearer $HTTP_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"questionId":"population-tax"}'

curl -X POST http://localhost:8787/api/tools/search_policies \
  -H "authorization: Bearer $HTTP_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"region":"상주시","age":34,"query":"스마트팜","stage":"예비창업"}'

curl -X POST http://localhost:8787/api/tools/search_council_records \
  -H "authorization: Bearer $HTTP_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"query":"지방소멸","dateFrom":"2020-01-01","dateTo":"2024-12-31","limit":5}'
```

모든 사실 응답은 최상위 `data_status`, `data_statuses`, `sources`,
`limitations`를 포함한다. 입력의 선택 `dataStatuses`로
`official_observed`/`demo_sample`을 명시할 수 있고 기본값은 둘 다 허용한다. 실제
반환 상태가 둘 이상이면 `data_status: "mixed"`이며 개별 상태는 `data_statuses`와
레코드에 유지된다. 단, 파생 통계는 label만으로 안전하다고 간주하지 않는다.
`dataStatus`와 지표의 회계 기준·금액 의미·source grain·원단위가 모두 같은 두 점
이상에서만 `summary`를 계산한다. 그 외에는 원 point와 homogeneous
`series_segments`를 유지하면서 `summary: null`과
`summary_unavailable_reason`을 반환한다. 인구/지방세 일치 verdict는 양쪽이 비교 가능한
공식 series일 때만 생성한다.

### HTTP 접근 제어

- `HTTP_AUTH_MODE=token`은 `/api/**`에 `Authorization: Bearer` 또는 `X-API-Key`를
  요구한다. token은 32바이트 이상이어야 하며 약한 placeholder는 시작 시 거절한다.
- `/health`, 최소 정보만 주는 `/ready`, 정적 UI는 공개다. token mode에서 공개 UI는
  API token을 브라우저에 넣지 않으므로 API 호출 기능은 reverse proxy 인증 연동 없이
  동작하지 않는다.
- token 비교는 SHA-256 고정 길이 digest를 constant-time 비교하며 token/raw body는
  로그나 감사 테이블에 저장하지 않는다.
- per-client 메모리 token bucket은 기본 분당 cheap 120회, PDF hybrid/데모/초안 등
  expensive 12회, readiness 60회다. 초과 시 `429`와 `Retry-After`를 반환한다.
- client는 기본적으로 socket IP다. `X-Forwarded-For`는 무시한다.
  `HTTP_TRUST_PROXY=loopback` 또는 `explicit`과 `HTTP_TRUST_PROXY_IPS`를 설정해
  immediate proxy를 정확히 신뢰한 경우에만 validated 첫 IP를 사용한다.
- JSON POST는 `application/json`, 기본 64KiB, depth 12/node 5,000 제한을 적용한다.
  고정 route/method/tool allowlist와 CSP/frame/referrer/permissions 보안 헤더를 사용하며
  cross-origin wildcard CORS를 제공하지 않는다.
- 모든 응답은 안전한 `X-Request-ID`를 반환한다. strict 형식의 inbound ID만 수용하고
  PostgreSQL audit의 `correlation_id`로 연결한다.
- `/api/admin/storage`는 token mode에서만 사용할 수 있다. 공개 `/ready`에는 DB 크기,
  version, PostgreSQL 설정을 노출하지 않는다.
- Node request/operation timeout과 PostgreSQL connection/statement/query timeout은
  `.env.example` 변수로 조정한다. 기본 DB statement/query timeout은 8초/10초다.

### 실행 repository

| `DATA_REPOSITORY` | 동작 |
|---|---|
| `auto` | `DATABASE_URL`이 있으면 PostgreSQL, 없으면 메모리 데모 |
| `postgres` | PostgreSQL 필수. 연결/스키마 실패 시 시작 실패하며 fallback하지 않음 |
| `memory`, `disabled` | 명시적으로 `data/sample/` 메모리 repository 사용 |

PostgreSQL 모드의 모든 SQL은 목적별 parameterized/bounded query다. 종료 시 pool을
닫으며, 도구 실행은 요청 원문 대신 salted SHA-256과 필드 타입/길이만
`mcp_tool_audit`에 best-effort로 기록한다. 감사 기록 실패는 운영 경고로 남지만 성공한
읽기 결과를 실패로 바꾸지 않는다. 배포 간 hash 상관이 필요하면
`AUDIT_HASH_SALT`를 secret manager에서 고정한다.

## 원천 데이터 ETL

원본은 읽기 전용으로 취급하며 복사·변경하지 않습니다.

```bash
# 파일을 쓰지 않고 전체 인벤토리·파싱 결과 확인
pnpm etl:dry-run

# data/generated/에 결정적 JSON 산출물 기록(같은 입력이면 unchanged)
pnpm etl

# ETL 재생성 + 스키마 적용 + 구조화 데이터와 PDF 전체 적재
pnpm db:normalize

# 이미 생성한 산출물을 적재(제한된 DB 사용자는 스키마 적용 생략 가능)
pnpm db:load -- --skip-schema

# 공식 원천만 적재하고 demo_sample은 제외
pnpm db:normalize -- --official-only

# PDF만 페이지 추출/chunk/로컬 임베딩 후 적재
pnpm pdf:normalize

# 개발·테스트용 파일 제한
pnpm pdf:normalize -- --limit 5

# golden page와 corpus 품질 분포 평가; report는 data/generated/에 기록
pnpm pdf:evaluate
pnpm pdf:evaluate -- --limit 5

# PDF 단계를 생략하거나 db:normalize 안에서 제한
pnpm db:normalize -- --skip-pdf
pnpm db:normalize -- --pdf-limit 5
```

ETL은 다음을 수행합니다.

1. 모든 파일의 경로(NFC 정규화), 크기, SHA-256, 기준일/수집시각, 형식을 카탈로그화
2. CSV를 UTF-8 우선, 실패 시 CP949로 해석
3. 포항 연도별 인구의 `년월` 날짜를 그대로 보존하고 다양한 의회 의안 CSV를 판별
4. 인구 XLSX 제목에서 `2026년 7월`을 찾아 `2026-07-31` 기준 경북/시군 값을 정규화
5. `datasets/new/`를 재귀 탐색하고 파일명이 아니라 헤더로 지방세 9개 grain과
   별도 격리 대상을 판별
6. 명시된 원/천원 단위를 KRW 정수로 바꾸고, 김천의 무표기 납부액은 명시적
   천원 징수자료와 6개 세목 exact match가 있을 때만 천원으로 판정
7. PDF 원천은 `catalog_only` source로 보존하면서 raw/cleaned page hash와 품질 지표를 기록
8. 문서 전체에서 고신뢰 반복 머리말/꼬리말만 제거하고 발언자 전환과 표 행을 원자적으로 chunk
9. 텍스트가 없는 문서/페이지는 `ocr_required`, 오류는 `extraction_failed`로 명시
10. 파싱 오류와 지방세 품질 문제를 각각 `errors.json`,
    `local-tax.quality.report.json` 및 종료 코드로 노출

`data/generated/`는 재생성 가능하므로 Git에서 제외됩니다.

### PostgreSQL 적재

적재기는 다음을 보장합니다.

- 경상북도와 현재 22개 시·군(군위군 제외)의 canonical 지역 키 사용
- 경로+SHA-256 기반 출처 버전 보존, PDF 포함 440개 원천 카탈로그 적재
- 500행 단위 parameterized upsert와 단일 fact 트랜잭션
- 원천 SHA/경로/행 번호 기반 의회 레코드 ID와 인구·의회 `source_locator`
- 재실행 시 중복 없이 upsert하며, 새 실행에 없는 기존 행은 삭제하지 않음
- 실패 시 fact 트랜잭션 rollback 및 가능한 경우 `ingestion_run.status = failed` 기록
- 미해결 지역/잘못된 행은 임의 ID를 만들지 않고 reject 수와 오류 보고서에 기록
- PDF page/chunk는 source version·extractor/chunker version·페이지·순번으로 결정적 ID를 만들고 이전 행은 삭제하지
  않되 현재 추출에 없는 chunk를 `is_current = false`로 제외
- 검색은 lifecycle에서 `approved`인 단일 version의 `approved_current` chunk만 사용
- embedding은 생성 batch마다 PostgreSQL에 적재해 전체 vector corpus를 메모리에 쌓지 않음
- 지방세 합계는 징수 수납액, 1인당 부담 원천의 지방세 총액, 납부액 순서로
  방어적으로 선택하며 `amount_semantics`와 `source_grain`을 보존
- 같은 지역·연도·세목에서는 `official_observed`를 `demo_sample`보다 우선하되
  서로 다른 상태를 한 점으로 합산하지 않음

현재 제공 원천과 샘플의 현재 행 기대 건수(`document_chunk`/embedding은 `is_current` join 기준):

| 테이블 | `official_observed` | `demo_sample` | `catalog_only` |
|---|---:|---:|---:|
| `data_source` | 39 | 4 | 401 |
| `population_observation` | 221 | 12 | - |
| `local_tax_revenue` | 368 | 12 | - |
| `local_tax_collection_status` | 220 | 0 | - |
| `local_tax_payment_media` | 1,131 | 0 | - |
| `local_tax_assessment_status` | 57 | 0 | - |
| `local_tax_per_capita_burden` | 15 | 0 | - |
| `local_tax_taxpayer_status` | 378 | 0 | - |
| `local_tax_exemption_status` | 96 | 0 | - |
| `local_tax_unrefunded_status` | 64 | 0 | - |
| `local_tax_enforcement_statistic` | 90 | 0 | - |
| `policy_program` | 0 | 3 | - |
| `council_record` | 46,596 | 5 | - |
| `document` | 401 | 0 | - |
| `document_page` | 11,712 | 0 | - |
| `document_chunk` | 23,795 | 0 | - |
| `document_chunk_embedding` | 23,795 | 0 | - |

```sql
SELECT data_status, count(*) FROM data_source GROUP BY data_status;
SELECT data_status, count(*) FROM population_observation GROUP BY data_status;
SELECT data_status, count(*) FROM local_tax_revenue GROUP BY data_status;
SELECT severity, issue_code, count(*) FROM data_quality_issue
GROUP BY severity, issue_code ORDER BY severity, issue_code;
SELECT data_status, count(*) FROM council_record GROUP BY data_status;
SELECT entity_type, count(*) FROM source_locator GROUP BY entity_type;
SELECT text_class, count(*) FROM document_page WHERE is_current GROUP BY text_class;
SELECT is_current, count(*) FROM document_chunk GROUP BY is_current;
```

### PDF source lifecycle과 저장공간 운영

새 extractor/chunker는 production 검색을 자동 변경하지 않고 `candidate`로 등록된다.
승인/rollback은 retained chunk와 embedding이 완전한지 확인한 뒤 한 transaction에서
가시성을 전환한다.

```bash
# version, current/stale 행, relation/index 크기, 안전한 DB 설정과 경고
pnpm lifecycle:status

# candidate 승인 또는 retained retired version rollback
pnpm lifecycle:approve -- \
  --version 'extractor::chunker' \
  --actor operator-name \
  --reason 'Golden/corpus evaluation passed'

# active approved version은 직접 retire할 수 없음
pnpm lifecycle:retire -- \
  --version 'extractor::old-chunker' \
  --actor operator-name \
  --reason 'Superseded and retained for rollback'

# 기본은 30일 보존 dry-run. 출력의 exact token 없이는 삭제 불가
pnpm lifecycle:purge -- --actor operator-name --retention-days 30
pnpm lifecycle:purge -- \
  --execute --confirm PLAN_TOKEN --batch-size 500 \
  --max-rows 10000 --max-runtime-seconds 60

# 만료 audit도 먼저 dry-run하고, 삭제 전 일별 aggregate를 보존
pnpm lifecycle:audit-purge -- --actor operator-name

# 기본은 allowlist 테이블 ANALYZE-only, 최대 10분
pnpm lifecycle:maintain -- --actor operator-name
```

purge는 advisory lock, 최소 보존기간, approved/current 보호, FK-safe batch와 정확한 plan
hash를 사용한다. 후보가 바뀌면 기존 token은 실행되지 않는다. `VACUUM`은 자동 실행하지
않으며 `--vacuum --confirm-vacuum`을 모두 요구한다. 이전 실측 `53100`은 shared memory
부족이므로 무작정 재시도하지 말고 `/dev/shm`, `shm_size`, disk,
`maintenance_work_mem`, parallel maintenance 설정을 점검한다.

현재 실측 stale 17,487 chunk/embedding은 migration 시점부터 보존기간을 다시 계산하므로
30일 dry-run 대상이 0건이며, **실제 stale corpus는 운영자 승인 전까지 삭제하지 않는다.**
purge는 base `document`/`data_source` provenance를 지우지 않고 version별 처리 상태만
정리한다. 논리 삭제 뒤 물리 공간 회수는 별도 maintenance window의 VACUUM 책임이다.

### PDF 임베딩과 검색

기본 provider는 네트워크를 사용하지 않는 384차원
`local/hashed-korean-token/1-d384`이다. 한글 단어·2/3글자 토큰을 feature hashing한
**retrieval-only lexical vector**이며 의미 임베딩 품질을 주장하지 않는다. 동일 content
hash의 임베딩은 재실행에서 생성하지 않는다.

```bash
# 기본: 로컬, 무료, 결정적
pnpm pdf:normalize -- --provider hashed

# 명시적으로 외부 전송을 허용한 경우에만 OpenAI 사용
OPENAI_API_KEY=... pnpm pdf:normalize -- \
  --provider openai --allow-external
```

provider마다 차원이 달라질 수 있어 임베딩은 JSONB가 아니라
`document_chunk_embedding.embedding real[]`과 dimension check로 저장한다. 현재 환경은
pgvector ANN을 요구하지 않으며 schema가 설치하는 `pg_trgm`과 `pgcrypto` extension,
PostgreSQL FTS로 최대 200개 lexical 후보를 만든 뒤 cosine rerank한다. 전용
`PostgresHybridSearchRepository`는 PostgreSQL MCP repository의 의회 검색에 연결되어
구조화 의안과 PDF chunk를 함께 반환한다.

전체 로컬 실행 결과는 PDF 401개, 11,712페이지, 현재 chunk/embedding 23,795개였고
추출/OCR 필요 문서는 0개였다. 105페이지는 near-empty, 12페이지는 table-likely였고
반복 머리말 543줄을 제거했다. 동일 입력 재실행은 embedding 23,795개를 모두 skip했다.
다른 원천에서는 실패 상태가 `document_page`와 page locator에 저장된다.

`pnpm pdf:evaluate`는 짧은 marker만 저장한 local golden 5페이지와 전체 corpus 분포를
평가해 `data/generated/pdf.quality.report.json`을 만든다. golden 실패, 실패 page 1% 초과,
OCR-required page 2% 초과만 severe regression으로 비정상 종료한다.

## 품질 명령

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pdf:evaluate
```

## 저장소 구조

```text
apps/web/                 정적 반응형 데모 UI
services/mcp-server/      stdio MCP + HTTP API
packages/domain/          Zod 입력, 공통 타입, 분석·초안 로직
packages/retrieval/       한글 lexical/hybrid 검색
packages/evaluation/      평가 결과 판정
pipelines/                원천 파일 인벤토리와 정규화
db/                       PostgreSQL 스키마와 마이그레이션
data/sample/              재배포 가능한 명시적 데모 샘플
evals/                    대표 평가 질문
docs/                     설계·도구·데이터 사전·변경 기록
```

## 현재 한계

- OCR 엔진은 포함하지 않는다. 텍스트 layer가 없는 PDF는 `ocr_required`로 남긴다.
- golden은 4개 local PDF의 5페이지만 다루며 실제 반복 footer 표본은 없어 합성 unit test로만 검증한다.
- 기본 임베딩은 의미 모델이 아닌 lexical feature hash이며 pgvector ANN을 사용하지 않는다.
- 샘플의 숫자와 정책/회의 내용은 공식 사실이 아닙니다.
- demo와 공식, 또는 서로 다른 금액 의미/회계 기준/grain/단위를 가로지르는 증감률은
  계산하지 않는다. demo 값은 claim 검증이나 공공문서 근거로 사용할 수 없다.
- 공식 지방세 합계 시계열은 현재 경산·구미·김천·봉화·청도 5개 지역,
  29개 지역-연도에 한정된다. 다른 지역·연도는 샘플 상태를 확인해야 한다.
- 영천 비과세·감면 720행은 금액/건수 열 의미가 검증되지 않아 적재하지 않았다.
- 김천 주소 단위 일반건축물 시가표준액 40,694행은 일반 분석·검색·embedding에서 제외했다.
- 인구와 지방세가 반대 방향으로 변했다는 사실만으로 인과관계를 주장하지 않습니다.
- token은 단일 shared secret이며 tenant/role 권한 모델은 없다.
- rate limit은 process-local이므로 여러 replica에서는 공용 Redis/게이트웨이가 필요하다.
- TLS 인증서와 secret rotation은 reverse proxy/배포 플랫폼 책임이다.
- stale 17,487건은 안전 보존 중이며 실제 purge와 물리 공간 회수는 운영자 승인/점검이 필요하다.

상세 내용은 [아키텍처](docs/architecture.md),
[데이터 사전](docs/data-dictionary.md), [MCP 도구 명세](docs/mcp-tools.md)를 참고하세요.

## 라이선스

코드는 MIT License입니다. 원천 공공데이터의 라이선스는 각 제공기관 조건을 따르며
이 저장소에는 원천 `datasets/`를 포함하지 않습니다.
