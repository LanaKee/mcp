# 경북 데이터 나침반

경상북도와 시·군의 인구·지방세·정책·의회 데이터를 **목적별 MCP 도구**로
조회하고, 결론·근거·출처·한계를 함께 보여 주는 해커톤용 vertical slice입니다.

> [!WARNING]
> 저장소의 지방세·정책·의회 데이터와 정규화 인구 샘플은 모두
> `data_status: "demo_sample"`인 기능 시연용 값입니다. 공식 통계·공고·회의록으로
> 인용하거나 실제 의사결정에 사용하면 안 됩니다. 로컬 `datasets/`를 처리한 ETL
> 결과만 `official_observed`로 구분하며, 그 경우에도 원출처 검토가 필요합니다.

## 구현 범위

- 반응형 한국어 웹 UI와 대표 질문 4개
- 공식 `@modelcontextprotocol/sdk` 기반 stdio MCP 서버
- 같은 도구를 호출하는 HTTP API와 데모 오케스트레이션
- 인구·지방세 추세, 교차 비교, 정책 자격 설명, 의회 검색, 주장 검증, 출처 조회,
  근거 제한형 행정문서 초안 등 8개 도구
- NFD 파일명에 의존하지 않고 헤더/내용으로 판별하는 CP949·UTF-8 CSV 및 XLSX ETL
- 제공된 CSV·PDF·XLSX 전체의 SHA-256 카탈로그 생성
- PDF.js 기반 401개 회의록/감사 PDF 페이지 추출, chunk, 로컬 임베딩 적재
- PostgreSQL 정규화 스키마, 마이그레이션, Docker Compose
- 한글 FTS/trigram과 저장 임베딩을 결합하는 PostgreSQL hybrid repository
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

개발 모드:

```bash
pnpm dev
```

### Docker

```bash
docker compose up --build
```

- 웹/API: <http://localhost:8787>
- PostgreSQL: `localhost:5432`
- 초기 스키마: `db/schema.sql`

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

## HTTP API

| 방식 | 경로 | 설명 |
|---|---|---|
| `GET` | `/health` | 상태 확인 |
| `GET` | `/api/questions` | 대표 질문 목록 |
| `POST` | `/api/demo` | 대표 질문 ID 실행 |
| `POST` | `/api/tools/:toolName` | MCP와 동일한 도구 함수 실행 |

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/api/demo \
  -H 'content-type: application/json' \
  -d '{"questionId":"population-tax"}'

curl -X POST http://localhost:8787/api/tools/search_policies \
  -H 'content-type: application/json' \
  -d '{"region":"상주시","age":34,"query":"스마트팜","stage":"예비창업"}'

curl -X POST http://localhost:8787/api/tools/search_council_records \
  -H 'content-type: application/json' \
  -d '{"query":"지방소멸","dateFrom":"2020-01-01","dateTo":"2024-12-31","limit":5}'
```

모든 사실 응답은 최상위 `data_status`, `sources`, `limitations`를 포함합니다.

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

# PDF 단계를 생략하거나 db:normalize 안에서 제한
pnpm db:normalize -- --skip-pdf
pnpm db:normalize -- --pdf-limit 5
```

ETL은 다음을 수행합니다.

1. 모든 파일의 경로(NFC 정규화), 크기, SHA-256, 기준일/수집시각, 형식을 카탈로그화
2. CSV를 UTF-8 우선, 실패 시 CP949로 해석
3. 포항 연도별 인구의 `년월` 날짜를 그대로 보존하고 다양한 의회 의안 CSV를 판별
4. 인구 XLSX 제목에서 `2026년 7월`을 찾아 `2026-07-31` 기준 경북/시군 값을 정규화
5. PDF 원천은 `catalog_only` source로 보존하면서 페이지 본문을 별도 document/chunk로 추출
6. 텍스트가 없는 문서/페이지는 `ocr_required`, 오류는 `extraction_failed`로 명시
7. 파싱 오류를 `errors.json`과 종료 코드로 노출

`data/generated/`는 재생성 가능하므로 Git에서 제외됩니다.

### PostgreSQL 적재

적재기는 다음을 보장합니다.

- 경상북도와 현재 22개 시·군(군위군 제외)의 canonical 지역 키 사용
- 경로+SHA-256 기반 출처 버전 보존, PDF 포함 422개 원천 카탈로그 적재
- 500행 단위 parameterized upsert와 단일 fact 트랜잭션
- 원천 SHA/경로/행 번호 기반 의회 레코드 ID와 인구·의회 `source_locator`
- 재실행 시 중복 없이 upsert하며, 새 실행에 없는 기존 행은 삭제하지 않음
- 실패 시 fact 트랜잭션 rollback 및 가능한 경우 `ingestion_run.status = failed` 기록
- 미해결 지역/잘못된 행은 임의 ID를 만들지 않고 reject 수와 오류 보고서에 기록
- PDF chunk는 source SHA/페이지/chunk 순번으로 결정적 ID를 만들고 이전 행은 삭제하지
  않되 현재 추출에 없는 chunk를 `is_current = false`로 제외

현재 제공 원천과 샘플을 최초 적재한 기대 건수:

| 테이블 | `official_observed` | `demo_sample` | `catalog_only` |
|---|---:|---:|---:|
| `data_source` | 21 | 4 | 401 |
| `population_observation` | 221 | 12 | - |
| `local_tax_revenue` | 0 | 12 | - |
| `policy_program` | 0 | 3 | - |
| `council_record` | 46,596 | 5 | - |
| `document` | 401 | 0 | - |
| `document_chunk` | 17,487 | 0 | - |
| `document_chunk_embedding` | 17,487 | 0 | - |

```sql
SELECT data_status, count(*) FROM data_source GROUP BY data_status;
SELECT data_status, count(*) FROM population_observation GROUP BY data_status;
SELECT data_status, count(*) FROM council_record GROUP BY data_status;
SELECT entity_type, count(*) FROM source_locator GROUP BY entity_type;
```

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
`PostgresHybridSearchRepository`는 구현되어 있지만 MCP 데모의 기본 in-memory 경로는
유지된다.

전체 로컬 실행 결과는 PDF 401개, 11,712페이지, 17,487 chunk였고 추출/OCR 필요 문서는
0개였다. 다른 원천에서는 실패 상태가 document와 page locator에 저장된다.

## 품질 명령

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
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

- 실행 API는 해커톤 재현성을 위해 아직 메모리의 샘플 파일을 사용합니다. PostgreSQL에는
  실제 ETL/샘플 데이터가 적재되지만 MCP 조회 repository 연결은 후속 범위입니다.
- OCR 엔진은 포함하지 않는다. 텍스트 layer가 없는 PDF는 `ocr_required`로 남긴다.
- 기본 임베딩은 의미 모델이 아닌 lexical feature hash이며 pgvector ANN을 사용하지 않는다.
- 샘플의 숫자와 정책/회의 내용은 공식 사실이 아닙니다.
- 인구와 지방세가 반대 방향으로 변했다는 사실만으로 인과관계를 주장하지 않습니다.

상세 내용은 [아키텍처](docs/architecture.md),
[데이터 사전](docs/data-dictionary.md), [MCP 도구 명세](docs/mcp-tools.md)를 참고하세요.

## 라이선스

코드는 MIT License입니다. 원천 공공데이터의 라이선스는 각 제공기관 조건을 따르며
이 저장소에는 원천 `datasets/`를 포함하지 않습니다.
