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
- PostgreSQL 정규화 스키마, 마이그레이션, Docker Compose
- 한글 토큰·부분 문자열·메타데이터 필터 검색과 교체 가능한 벡터 어댑터 경계
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
psql "$DATABASE_URL" -f db/migrations/001_initial.sql
```

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
```

ETL은 다음을 수행합니다.

1. 모든 파일의 경로(NFC 정규화), 크기, SHA-256, 기준일/수집시각, 형식을 카탈로그화
2. CSV를 UTF-8 우선, 실패 시 CP949로 해석
3. 파일명 대신 헤더로 포항 연도별 인구 및 다양한 의회 의안 CSV를 판별
4. 인구 XLSX의 시트와 행을 탐색해 시군 인구 후보를 정규화
5. PDF는 해시와 원문 위치를 보존해 `catalog_only`로 기록
6. 파싱 오류를 `errors.json`과 종료 코드로 노출

`data/generated/`는 재생성 가능하므로 Git에서 제외됩니다.

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

- 실행 API는 해커톤 재현성을 위해 메모리의 샘플 파일을 사용합니다. PostgreSQL 스키마와
  ETL 산출물은 실제 적재 계층의 계약이며 DB repository 연결은 후속 범위입니다.
- PDF는 전량 카탈로그화하지만 OCR/본문 추출은 하지 않습니다.
- 기본 검색은 외부 임베딩 없이 한글 어휘·부분 문자열 검색입니다.
- 샘플의 숫자와 정책/회의 내용은 공식 사실이 아닙니다.
- 인구와 지방세가 반대 방향으로 변했다는 사실만으로 인과관계를 주장하지 않습니다.

상세 내용은 [아키텍처](docs/architecture.md),
[데이터 사전](docs/data-dictionary.md), [MCP 도구 명세](docs/mcp-tools.md)를 참고하세요.

## 라이선스

코드는 MIT License입니다. 원천 공공데이터의 라이선스는 각 제공기관 조건을 따르며
이 저장소에는 원천 `datasets/`를 포함하지 않습니다.
