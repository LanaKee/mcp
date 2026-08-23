# G-BAP (Gyeongbuk Behind-the-scenes Access Platform)

경상북도와 시·군의 인구·지방세·정책·의회 데이터를 **목적별 MCP 도구**로
조회하고, 결론·근거·출처·한계를 함께 보여 주는 해커톤용 vertical slice입니다.

> [!IMPORTANT]
> 운영 데이터와 기본 조회는 `official_observed`만 사용한다. 결과를 사용할 때도
> 원출처와 기준일을 확인해야 한다. `demo_sample` 운영 행과 자동 fallback은 제거했다.

## 구현 범위

- 반응형 한국어 웹 UI와 대표 질문 4개
- 공식 `@modelcontextprotocol/sdk` 기반 MCP 서버(로컬 stdio + 호스팅용 Streamable HTTP)
- 같은 도구를 호출하는 HTTP API와 데모 오케스트레이션
- 인구·지방세 추세, 교차 비교, 정책 자격 설명, 의회 검색, 보도자료 검색,
  의원별 의안 검색, 주장 검증, 출처 조회, 근거 제한형 행정문서 초안 등 10개 도구
- NFD 파일명에 의존하지 않고 헤더/내용으로 판별하는 CP949·UTF-8 CSV 및 XLSX ETL
- 9개 지방세 원천 grain과 행정안전부 HWPX 연감의 KRW 단위 정규화, 품질 검증,
  격리와 공식 우선 조회
- 제공된 CSV·PDF·XLSX 전체의 SHA-256 카탈로그 생성
- 경상북도 보도자료 13,707건(2020~2026) 크롤과 서술적 맥락 전용 검색 도구
- 경상북도의회 의원 64명·발의의안 1,454건·발의자 관계 24,178건 크롤과
  대표발의/공동발의를 분리한 의원별 의안 검색 도구
- PDF.js 기반 408개 회의록·감사·도정 업무계획 PDF 페이지 추출, chunk, 로컬 임베딩 적재
- page-level 한국어 plausibility/mojibake 지표, 반복 머리말 제거, 발언자/표 경계
  chunk와 golden 회귀 평가
- 승인된 PDF 처리 version만 검색하는 lifecycle, 보존기간·확인 token 기반 purge와 용량 보고
- PostgreSQL 정규화 스키마, 마이그레이션, Docker Compose
- 한글 FTS/trigram과 저장 임베딩을 결합하는 PostgreSQL hybrid repository
- feature flag 기반 PostgreSQL MCP repository, readiness, redacted 도구 감사 로그
- Vitest 기반 도메인·검색·ETL·도구·HTTP 테스트

## 벤치마크: 근거 계층이 실제로 만드는 차이

"그냥 ChatGPT/RAG에 물어보면 되는 것 아닌가?"에 답하기 위해, **같은 모델·같은 질문**에
데이터 계층 접근 여부만 바꿔서 측정했습니다. 채점은 LLM 심판 없이 결정론적 코드로만
하고, 정답은 실행 시점에 PostgreSQL에서 직접 조회합니다. 방법론 전체는
[`benchmark/README.md`](benchmark/README.md)에 있습니다.

### 1) Vanilla LLM vs MCP(G-BAP) — 22문항 · 6범주, 3개 모델

| 모델 | 정확도 (vanilla → MCP) | 환각률·답변대비 (vanilla → MCP) | 출처검증 가능 비율 (vanilla → MCP) |
| --- | ---: | ---: | ---: |
| `claude-sonnet-5` | 50.0% → **81.8%** (+31.8p) | 50.0% → **16.7%** | 0.0% → **80.0%** |
| `gpt-4o-mini` | 27.3% → **72.7%** (+45.5p) | 33.3% → **22.2%** | 0.0% → **56.8%** |
| `gpt-5.6-luna` | 36.4% → **81.8%** (+45.5p) | 63.6% → **11.8%** | 0.0% → **65.9%** |

- 정확도는 유효 실행 3개 모델 전부에서 MCP arm이 더 높습니다.
- vanilla의 출처 검증 가능 비율은 **모든 모델에서 0%**입니다. 출처를 안 대서가 아니라,
  대는 출처가 실재하는 행에 대응하지 않기 때문입니다.
- `abstention`(자료가 실제로 없는 질문) 범주는 답하지 않는 것이 정답이며, MCP arm은
  세 모델 모두 부재 인지 정확도 100%를 기록합니다.
- 전체 결과는 [`benchmark/reports/COMPARISON.md`](benchmark/reports/COMPARISON.md).

### 2) 무가공 RAG vs 정규화 데이터 계층(G-BAP) — 10문항 차별성 실험

동일 모델(`gpt-5.6-luna`)에 (a) 원본 파일 446개·25.8만 chunk를 단순 lexical
retrieval로 넘긴 arm과, (b) 정규화·metadata·provenance·coverage를 갖춘 G-BAP 도구
arm을 비교했습니다.

| 지표 | Raw Retrieval (RAG) | G-BAP (구조화 계층) |
| --- | ---: | ---: |
| 정확도 | 60.0% | **90.0%** |
| 답변 시도율 | 50.0% | **70.0%** |
| 환각률 (답변 대비) | 40.0% | **14.3%** |
| 부재 인지 정확도 | 100.0% | 100.0% |
| 출처 검증 가능 비율 | 0.0% | **56.3%** |

원본 문서를 그대로 검색에 넣어도 어느 정도는 맞히지만(60%), 단위 정규화·품질
검증·출처 테이블까지 갖춘 계층은 정확도를 90%까지 올리고 환각을 1/3 이하로
줄입니다. 전체 결과는
[`raw-rag-vs-mcp-gpt-5.6-luna-gyeongbuk-v2/report.md`](benchmark/reports/raw-rag-vs-mcp-gpt-5.6-luna-gyeongbuk-v2/report.md).

### 재현

```bash
pnpm benchmark:compare:dry-run   # API 호출 없이 채점기·문항 전제만 검증
pnpm benchmark:compare           # vanilla vs MCP 전체 비교
pnpm benchmark:raw-rag           # 무가공 RAG vs 구조화 계층 비교
```

> 문항 22개 중 일부 모델은 temperature를 고정할 수 없어 표본이 크지 않습니다. 모델 간
> 절대 순위 비교가 아니라 각 모델 **내부**의 vanilla → MCP 변화량을 보는 지표입니다.
> `common_knowledge` 범주(대조군)는 일부러 vanilla가 이길 수 있게 설계했습니다.

## 빠른 시작

요구사항: Node.js 22 이상, pnpm 10 이상

```bash
pnpm install
pnpm test
pnpm build
pnpm start
```

브라우저에서 <http://localhost:8787>을 엽니다.

화면은 `prototype/`의 Next.js 앱이고 3100에 뜬다. 8787은 자기 경로(`/mcp`,
`/health`, `/ready`, `/api/*`)를 뺀 나머지를 그리로 넘긴다. `pnpm start`와
`pnpm dev`가 두 프로세스를 함께 띄우므로 따로 실행할 것은 없다. 화면 없이
서버만 띄우려면 `SKIP_PROTOTYPE=1`이고, 그때 화면 경로는 404다. 이미 떠 있는
화면을 쓰려면 `PROTOTYPE_ORIGIN`에 그 주소를 준다.

| 명령 | 하는 일 |
| --- | --- |
| `pnpm start` | 화면(3100) + MCP 서버(8787) |
| `pnpm dev` | 같은 구성을 개발 모드로 |
| `pnpm start:server` | MCP 서버만 |
| `SKIP_PROTOTYPE=1 pnpm start` | MCP 서버만 (화면 경로 404) |

`DATA_REPOSITORY=auto`가 기본이며 `DATABASE_URL`이 없거나 PostgreSQL이 준비되지
않으면 시작에 실패한다. 명시적 메모리 모드는 빈 저장소로 시작한다. `.env`는 서버가 자동으로 읽는다. 로컬 HTTP
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
    "g-bap": {
      "command": "node",
      "args": [
        "/absolute/path/to/g-bap/services/mcp-server/dist/index.js",
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

## MCP 원격 호스팅 (Streamable HTTP)

HTTP 모드로 실행하면 `/mcp` 경로에서 MCP 표준 Streamable HTTP transport를
제공한다. stdio와 완전히 같은 tool 목록을 노출한다.

```bash
HTTP_HOST=0.0.0.0 \
PORT=8787 \
HTTP_AUTH_MODE=token \
HTTP_AUTH_TOKEN=<32바이트 이상 토큰> \
DATABASE_URL=postgresql://... \
DATA_REPOSITORY=postgres \
node services/mcp-server/dist/index.js --http
```

원격 MCP 클라이언트 등록:

```json
{
  "mcpServers": {
    "g-bap": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer <HTTP_AUTH_TOKEN>" }
    }
  }
}
```

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `MCP_MAX_SESSIONS` | `256` | 동시 세션 상한. 초과 시 `503` |
| `MCP_SESSION_IDLE_MS` | `600000` | idle 세션 회수 기준 |
| `MCP_ALLOWED_HOSTS` | (비어 있음) | DNS rebinding 방어 Host allow-list |
| `MCP_ALLOWED_ORIGINS` | (비어 있음) | 동 Origin allow-list |

- 공개 호스팅에서는 `HTTP_AUTH_MODE=token`을 반드시 설정한다.
  인증 실패 시 세션이 생성되지 않고 `401`로 끊는다.
- `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS`가 모두 비어 있으면 DNS rebinding
  방어가 꺼진다. 신뢰할 수 있는 proxy 뒤가 아니라면 설정한다.
- `/mcp`의 프로토콜 트래픽은 cheap 예산을, `tools/call` 중 비용이 큰 tool은
  추가로 expensive 예산을 소비한다. 자세한 내용은
  [docs/CHANGES_HOSTED_MCP_SERVER.md](docs/CHANGES_HOSTED_MCP_SERVER.md).

## HTTP API

| 방식 | 경로 | 설명 |
|---|---|---|
| `GET` | `/health` | 프로세스 생존 확인 |
| `GET` | `/ready` | 최소 ready/not-ready 상태만 공개 |
| `GET` | `/api/questions` | 대표 질문 목록 |
| `GET` | `/api/admin/storage` | token 전용 DB 용량·lifecycle·안전한 설정 요약 |
| `POST` | `/api/agent` | 자연어 질문을 받아 데이터셋 탐색·도구 선택·근거 수집까지 수행 |
| `POST` | `/api/tools/:toolName` | MCP와 동일한 도구 함수 실행 |

```bash
curl http://localhost:8787/health

export HTTP_AUTH_TOKEN="$(openssl rand -hex 32)"
HTTP_AUTH_MODE=token pnpm start

curl -X POST http://localhost:8787/api/agent \
  -H "authorization: Bearer $HTTP_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"question":"포항시는 2018년부터 2024년까지 인구는 줄었는데 지방세 세수는 늘었나?"}'

curl -X POST http://localhost:8787/api/tools/search_policies \
  -H "authorization: Bearer $HTTP_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"region":"상주시","age":34,"query":"스마트팜","stage":"예비창업"}'

curl -X POST http://localhost:8787/api/tools/search_council_records \
  -H "authorization: Bearer $HTTP_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"query":"지방소멸","dateFrom":"2020-01-01","dateTo":"2024-12-31","limit":5}'

# 보도자료는 서술적 맥락 전용이라 dataStatuses를 받지 않는다
curl -X POST http://localhost:8787/api/tools/search_press_releases \
  -H "authorization: ******" \
  -H 'content-type: application/json' \
  -d '{"query":"청년 일자리","dateFrom":"2024-01-01","limit":5}'

# 의원별 의안. 대표발의(lead)와 공동발의(co)는 절대 합산하지 않는다
curl -X POST http://localhost:8787/api/tools/search_member_bills \
  -H "authorization: ******" \
  -H 'content-type: application/json' \
  -d '{"member":"김대진","query":"산림","role":"lead","limit":5}'
```

모든 사실 응답은 최상위 `data_status`, `data_statuses`, `sources`,
`limitations`를 포함한다. 입력의 선택 `dataStatuses`로
`official_observed`/`demo_sample`을 명시할 수 있지만 기본값은 공식 자료만 허용한다. 실제
반환 상태가 둘 이상이면 `data_status: "mixed"`이며 개별 상태는 `data_statuses`와
레코드에 유지된다. 단, 파생 통계는 label만으로 안전하다고 간주하지 않는다.
`dataStatus`와 지표의 회계 기준·금액 의미·source grain·원단위가 모두 같은 두 점
이상이고, 인구는 측정기준과 기준일 정밀도도 같을 때만 `summary`를 계산한다.
그 외에는 원 point와 homogeneous
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
| `auto` | `DATABASE_URL`과 준비된 PostgreSQL이 필수이며 실패 시 시작 중단 |
| `postgres` | PostgreSQL 필수. 연결/스키마 실패 시 시작 실패하며 fallback하지 않음 |
| `memory`, `disabled` | 명시적으로 빈 메모리 repository 사용 |

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

# 공개 포항시의회 의안 갱신(약관 검토 필수; robots 확인 불가 시 별도 승인)
pnpm pohang:crawl -- --acknowledge-terms --acknowledge-robots-unavailable

# 경상북도 보도자료 수집(서술적 맥락용; 통계 근거가 아님)
pnpm gb:press:crawl --accept-terms --since=2020-01-01

# 경상북도의회 의원 명부와 발의의안 수집(약 25분)
pnpm gb:council:crawl --accept-terms

# ETL 재생성 + 스키마 적용 + 구조화 데이터와 PDF 전체 적재
pnpm db:normalize

# 이미 생성한 산출물을 적재(제한된 DB 사용자는 스키마 적용 생략 가능)
pnpm db:load -- --skip-schema

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

### 신규 데이터 접수(intake)

새로 받은 원본 파일은 `datasets/`에 직접 넣지 말고 `data/intake/inbox/`에 둡니다.
접수 → 검증 → 중복 판정 → 저장 → 가공 → 원장 기록의 6단계를 거칩니다.

```bash
# 실제 이동 없이 처리 계획만 확인
pnpm intake:dry-run

# 접수 실행(저장 후 정규화·적재까지)
pnpm intake

# 원장 요약(접수/중복/격리 건수)
pnpm intake:status
```

- 검증은 확장자가 아니라 실제 바이트 signature를 봅니다. `.csv`로 저장된 HTML
  오류 페이지나 PDF가 아닌 `.pdf`는 사유 sidecar와 함께 격리됩니다.
- 중복 판정은 원본 저장소 전체의 SHA-256과 대조하므로, 같은 파일을 다시 받아도
  이중 적재되지 않습니다.
- 저장 위치는 파일명이 아니라 판별된 내용 종류로 결정됩니다.
- 모든 판정은 `raw_intake_file` 원장에 남아 사후 추적이 가능합니다.

ETL은 다음을 수행합니다.

1. 모든 파일의 경로(NFC 정규화), 크기, SHA-256, 기준일/수집시각, 형식을 카탈로그화
2. CSV를 UTF-8 우선, 실패 시 CP949로 해석
3. 포항 연도별 인구의 `년월` 날짜를 그대로 보존하고 다양한 의회 의안 CSV를 판별
4. 인구 XLSX 제목에서 `2026년 7월`을 찾아 `2026-07-31` 기준 경북/시군 값을 정규화
5. `datasets/new/`를 재귀 탐색하고 파일명이 아니라 CSV 헤더 또는 HWPX 내부
   장/표 marker로 지방세 9개 grain, 공식 연감과 별도 격리 대상을 판별
6. 명시된 원/천원 단위를 KRW 정수로 바꾸고, 김천의 무표기 납부액은 명시적
   천원 징수자료와 6개 세목 exact match가 있을 때만 천원으로 판정
7. PDF 원천은 raw/cleaned page hash, 추출 방식과 품질 지표를 기록하며 읽을 수 있는
   공식 문서만 `official_observed`로 승격
8. 문서 전체에서 고신뢰 반복 머리말/꼬리말만 제거하고 발언자 전환과 표 행을 원자적으로 chunk
9. Unicode 한글 비율 외에 행정 용어·valid bigram·조사·rare syllable·공백/문장부호를
   검사해 `extracted_ok`, `mojibake_suspected`, `unusable_for_retrieval`, `empty`를 구분
10. 제외 page는 hash·분류·근거만 보존하고 chunk/embedding/search에 넣지 않음
11. 파싱 오류와 지방세 품질 문제를 각각 `errors.json`,
    `local-tax.quality.report.json` 및 종료 코드로 노출

`data/generated/`는 재생성 가능하므로 Git에서 제외됩니다.

### PostgreSQL 적재

적재기는 다음을 보장합니다.

- 경상북도와 현재 22개 시·군(군위군 제외)의 canonical 지역 키 사용
- 경로+SHA-256 기반 출처 버전 보존. 현재 실행은 HWPX 연감, 별도 추가 PDF,
  보도자료와 의회 의안을 포함한 977개 원천을 카탈로그에 적재
- 500행 단위 parameterized upsert와 단일 fact 트랜잭션
- 일반 CSV는 원천 SHA/경로/행 번호, 포항 공개 의안은 원문 레코드 ID 기반의
  결정적 의회 레코드 ID와 인구·의회 `source_locator`
- 보도자료는 게시판 게시물 id(`gb-press-<B_STEP>`)로 식별해 재크롤 시 행이 늘지 않음
- 경상북도의회 의안은 사이트의 32-hex `bill_uid`로 식별한다. 의안번호는 대수마다
  재사용되므로 키로 쓰지 않으며, 발의자는 `role`(`lead`/`co`)로 분리해 적재한다
- 재실행 시 중복 없이 upsert하며, 새 실행에 없는 기존 행은 삭제하지 않음
- 실패 시 fact 트랜잭션 rollback 및 가능한 경우 `ingestion_run.status = failed` 기록
- 미해결 지역/잘못된 행은 임의 ID를 만들지 않고 reject 수와 오류 보고서에 기록
- PDF page/chunk는 source version·extractor/chunker version·페이지·순번으로 결정적 ID를 만들고 이전 행은 삭제하지
  않되 현재 추출에 없는 chunk를 `is_current = false`로 제외
- 검색은 lifecycle에서 `approved`인 단일 version의 `approved_current` chunk만 사용
- embedding은 생성 batch마다 PostgreSQL에 적재해 전체 vector corpus를 메모리에 쌓지 않음
- 지방세 합계는 동일 범위의 지자체 징수 수납액, 행정안전부 연감의 시·군세 소계,
  1인당 부담 원천의 지방세 총액, 납부액 순서로 방어적으로 선택하며
  `amount_semantics`와 `source_grain`을 보존
- 도세+시·군세 결합 합계는 `headlineEligible=false`로 보존하고 도구용 시·군세
  headline에서 제외
- 운영 로드 계획은 `official_observed`와 `catalog_only`만 만들며 `demo_sample`을 생성하지 않음

현재 제공 원천과 샘플의 현재 행 기대 건수(`document_chunk`/embedding은 `is_current` join 기준):

| 테이블 | `official_observed` | `demo_sample` | `catalog_only` |
|---|---:|---:|---:|
| `data_source` | 972 | 0 | 5 |
| `population_observation` | 272 | 0 | - |
| `local_tax_revenue` | 544 | 0 | - |
| `local_tax_collection_status` | 220 | 0 | - |
| `local_tax_payment_media` | 1,131 | 0 | - |
| `local_tax_assessment_status` | 57 | 0 | - |
| `local_tax_per_capita_burden` | 23 | 0 | - |
| `local_tax_taxpayer_status` | 378 | 0 | - |
| `local_tax_exemption_status` | 96 | 0 | - |
| `local_tax_unrefunded_status` | 64 | 0 | - |
| `local_tax_enforcement_statistic` | 90 | 0 | - |
| `policy_program` | 0 | 0 | - |
| `council_record` | 49,708 | 0 | - |
| `council_member` | 64 | 0 | - |
| `council_bill` | 1,454 | 0 | - |
| `press_release` | 13,707 | 0 | - |
| `document` | 405 | 0 | 3 |

`datasets/extra/`의 2021·2023·2025·2026 도정 업무계획은 공식 page passage로
검색된다. 2020·2022는 CID mojibake, 2024는 usable text layer가 없어
catalog/provenance와 제외 근거만 보존하고 검색에는 넣지 않는다.

공식 인구와 공식 headline 지방세의 중첩은 16개 지역-연도/5개 지역이다
(봉화 2017~2024, 구미 2023~2025, 청도 2020~2022, 경산 2025, 포항 2024).
구미 2023~2025와 청도 2020~2022는 과세연도 보고서에 명시된 인구로 공식 시계열을
구성한다. 이 수치는 새 데이터를 적재하면 늘어나므로 테스트는 값을 고정하지 않고
중첩이 두 테이블 모두에 실재하는지만 검증한다. 기존 대표 기간 2022~2024는 endpoint가 부족해 유지하지 않고, 공식 비교가
가능한 2020~2022 청도 사례로 대표 질문을 변경했다.

| PDF current 항목 | 건수 |
|---|---:|
| `document_page` | 12,522 |
| `document_page` `extracted_ok` | 12,178 |
| 제외 page (`mojibake_suspected`/`unusable_for_retrieval`/`empty`) | 344 |
| `document_chunk` | 24,565 |
| current `document_chunk_embedding` | 24,565 |

경상북도 보도자료는 통계 fact가 아니라 서술적 맥락이므로 fact 모델 밖의 별도
`press_release` 테이블에 저장한다.

| 보도자료 항목 | 값 |
|---|---|
| 레코드 | 13,707 |
| 기간 | 2020-01-06 ~ 2026-08-21 (80개월, 누락 없음) |
| `extracted_ok` (검색 대상) | 13,702 |
| `unusable_for_retrieval` | 5 (빈 본문 4, 마크업 복구 불가 1) |
| 첨부 보유 | 13,674 |

경상북도의회 의원·의안도 통계 fact가 아니라 의정활동 기록이므로 별도
`council_member` / `council_bill` / `council_bill_sponsor`에 저장한다.

| 의회 항목 | 값 |
|---|---|
| 의원 | 64 (국민의힘 58 / 무소속 3 / 더불어민주당 3) |
| 선거구 → `region_id` 해석 | 56 (비례대표 8명은 null) |
| 의안 | 1,454 (2006-12-26 ~ 2026-08-14) |
| 발의자 관계 | 24,178 (대표발의 1,449 / 공동발의 22,729) |
| 현 명부와 연결된 발의자 | 8,529 (나머지는 지난 대수 의원, 이름만 보존) |

> [!IMPORTANT]
> 기존 `council_record`는 **포항시의회** 회의록이고 `council_*` 세 테이블은
> **경상북도의회**다. 서로 다른 기관이므로 조인하거나 합산하면 안 된다.
> 대표발의(`lead`)와 공동발의(`co`)도 합산하면 의정활동이 과대평가된다.

```sql
SELECT data_status, count(*) FROM data_source GROUP BY data_status;
SELECT data_status, count(*) FROM population_observation GROUP BY data_status;
SELECT data_status, count(*) FROM local_tax_revenue GROUP BY data_status;
SELECT severity, issue_code, count(*) FROM data_quality_issue
GROUP BY severity, issue_code ORDER BY severity, issue_code;
SELECT data_status, count(*) FROM council_record GROUP BY data_status;
SELECT content_classification, count(*) FROM press_release
GROUP BY content_classification;
SELECT entity_type, count(*) FROM source_locator GROUP BY entity_type;
SELECT text_class, count(*) FROM document_page WHERE is_current GROUP BY text_class;
SELECT content_classification, count(*) FROM document_page
WHERE is_current GROUP BY content_classification;
SELECT is_current, count(*) FROM document_chunk GROUP BY is_current;
```

### PDF source lifecycle과 저장공간 운영

새 extractor/chunker는 production 검색을 자동 변경하지 않고 `candidate`로 등록된다.
승인/rollback은 retained chunk와 embedding이 완전한지 확인한 뒤 한 transaction에서
가시성을 전환한다. 과거 version rollback은 당시 존재하지 않았던 신규 문서를 일시적으로
숨길 수 있으므로 반환된 document/page/chunk coverage를 확인해야 한다.

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

새 policy extraction version 승인 후 이전 23,795개와 legacy 17,487개, 합계 41,282개
stale chunk/embedding을 보존한다. **실제 stale corpus는 운영자 승인 전까지 삭제하지 않는다.**
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

전체 로컬 실행 결과는 PDF 408개, 12,522페이지, 현재 chunk/embedding 24,565개다.
페이지는 `extracted_ok` 12,178, `mojibake_suspected` 172,
`unusable_for_retrieval` 166,
`empty` 6이며 제외 page에서 생성된 chunk는 0개다. 기존 401개 corpus만 다시 검사하면
11,712페이지 전부 `extracted_ok`다. 반복 머리말 543줄을 제거했다.

`pnpm pdf:evaluate`는 짧은 marker만 저장한 local golden 6페이지와 전체 corpus 분포를
평가해 `data/generated/pdf.quality.report.json`을 만든다. golden 실패, failed page 1%
초과, excluded-page chunk 오염, 읽을 수 있지만 연도/문서유형 증거를 검증하지 못한
정책 문서를 severe regression으로 처리한다.

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
prototype/                Next.js 화면(8787이 여기로 넘긴다)
services/mcp-server/      MCP 서버(stdio · Streamable HTTP) + HTTP API
packages/domain/          Zod 입력, 공통 타입, 분석·초안 로직
packages/retrieval/       한글 lexical/hybrid 검색
packages/evaluation/      평가 결과 판정
pipelines/                원천 파일 인벤토리와 정규화
db/                       PostgreSQL 스키마와 마이그레이션
services/mcp-server/test-fixtures/demo/  demo 거부 동작만 검증하는 테스트 fixture
evals/                    대표 평가 질문
docs/                     설계·도구·데이터 사전·변경 기록
```

## 현재 한계

- 2020·2022·2024 업무계획 본문 재수집은 이번 범위 밖이다. 향후 별도 승인된
  source replacement 또는 OCR 결정 없이는 검색 coverage를 주장하지 않는다.
- 보도자료는 도가 발표한 서술형 announcement이며 관측된 통계가 아니다. 본문의
  수치는 발표 시점의 계획이므로 `verify_claim_with_data`의 근거로 쓸 수 없고,
  `mentioned_regions`는 본문에 시군 이름이 등장했다는 뜻일 뿐 관할을 뜻하지 않는다.
- golden은 5개 local PDF의 6페이지만 다루며 실제 반복 footer 표본은 없어 합성 unit test로만 검증한다.
- 기본 임베딩은 의미 모델이 아닌 lexical feature hash이며 pgvector ANN을 사용하지 않는다.
- 샘플의 숫자와 정책/회의 내용은 공식 사실이 아닙니다.
- demo와 공식, 또는 서로 다른 금액 의미/회계 기준/grain/단위를 가로지르는 증감률은
  계산하지 않는다. demo 값은 claim 검증이나 공공문서 근거로 사용할 수 없다.
- 공식 지방세 합계는 2024년 기준 현재 22개 시·군 전체를 포괄하고, 기존 CSV 기간을
  합쳐 46개 지역-연도다. 다년 homogeneous series는 여전히 경산·구미·봉화·청도 등
  일부 지역에만 있으므로 한 점뿐인 지역은 증감률을 계산하지 않는다.
- 영천 비과세·감면 720행은 금액/건수 열 의미가 검증되지 않아 적재하지 않았다.
- 김천 주소 단위 일반건축물 시가표준액 40,694행은 일반 분석·검색·embedding에서 제외했다.
- 인구와 지방세가 반대 방향으로 변했다는 사실만으로 인과관계를 주장하지 않습니다.
- token은 단일 shared secret이며 tenant/role 권한 모델은 없다.
- rate limit은 process-local이므로 여러 replica에서는 공용 Redis/게이트웨이가 필요하다.
- TLS 인증서와 secret rotation은 reverse proxy/배포 플랫폼 책임이다.
- stale 41,282건은 안전 보존 중이며 실제 purge와 물리 공간 회수는 운영자 승인/점검이 필요하다.

상세 내용은 [아키텍처](docs/architecture.md),
[데이터 사전](docs/data-dictionary.md), [MCP 도구 명세](docs/mcp-tools.md)를 참고하세요.

## 라이선스

코드는 MIT License입니다. 원천 공공데이터의 라이선스는 각 제공기관 조건을 따르며
이 저장소에는 원천 `datasets/`를 포함하지 않습니다.
