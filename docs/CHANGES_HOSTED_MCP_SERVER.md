# 호스팅 가능한 MCP 서버 (Streamable HTTP)

## 배경

이전까지 MCP 프로토콜을 말할 수 있는 transport는 stdio 하나뿐이었다.
`services/mcp-server/src/http.ts`가 제공하던 `/api/tools/<name>`은 MCP가 아니라
자체 REST-ish JSON API였기 때문에, 원격 MCP 클라이언트는 이 서버에 붙을 수 없었다.

즉 서버를 배포해도 MCP 클라이언트는 반드시 같은 머신에서 프로세스를 직접
실행해야 했고, 이는 "호스팅 가능한 MCP 서버"가 아니었다.

## 변경 요약

MCP 표준 **Streamable HTTP** transport를 `/mcp` 경로에 추가했다.
stdio와 HTTP가 **같은 tool surface**를 보도록 서버 생성 로직을 하나로 합쳤다.

| 파일 | 역할 |
| --- | --- |
| `services/mcp-server/src/mcp-server.ts` | 신규. `createMcpServer(registry)` 공용 팩토리 |
| `services/mcp-server/src/mcp.ts` | stdio 진입점이 공용 팩토리에 위임하도록 축소 |
| `services/mcp-server/src/mcp-http.ts` | 신규. 세션 관리자 + `/mcp` 요청 처리 |
| `services/mcp-server/src/http.ts` | `/mcp` 라우트, 공용 본문 reader, method 기반 rate limit |
| `services/mcp-server/src/index.ts` | graceful shutdown 시 세션 drain, idle sweep 타이머 |

### 1. 공용 tool surface

`createMcpServer(registry)`가 `ListTools`/`CallTool` 핸들러를 등록하고,
stdio와 HTTP 양쪽이 이 함수를 호출한다. 원격 클라이언트가 로컬 클라이언트와
다른 tool 목록을 보는 상황이 구조적으로 발생할 수 없다.

`mcp-http.test.ts`가 노출된 tool 이름 집합이 `registry.tools`의 키와 정확히
일치하는지 검증한다.

### 2. 세션 수명 관리

호스팅에서 세션은 프로세스 메모리에 남는다. 두 가지 실패 모드를 처리했다.

- **무한 증가**: `MCP_MAX_SESSIONS`(기본 256)를 넘으면 새 세션을 `503`으로 거절한다.
  `retry-after` 헤더를 함께 보낸다.
- **사라진 클라이언트**: DELETE를 보내지 않고 사라진 클라이언트의 세션은
  `MCP_SESSION_IDLE_MS`(기본 10분) 초과 시 회수한다. 요청이 들어올 때만이 아니라
  `index.ts`의 주기적 sweep 타이머로도 회수한다.

`closeAll()`은 SIGTERM/SIGINT 시 호출된다. Streamable HTTP는 SSE 응답을 길게
열어두기 때문에, 세션을 먼저 닫지 않으면 `server.close()`가 끝나지 않는다.

### 3. 알 수 없는 세션을 새 세션으로 승격하지 않는다

- 세션 헤더가 있는데 서버가 모르는 값이면 `404` (`-32001`).
- 세션 헤더가 없고 `initialize`도 아니면 `400` (`-32000`).

세션을 잃은 클라이언트에게 조용히 새 세션을 발급하면, 클라이언트는 자신이
가지고 있다고 믿는 상태가 사라진 사실을 모른 채 계속 진행하게 된다.

### 4. JSON-RPC 본문 reader

기존 `jsonBody()`는 재사용할 수 없었다.

- 최상위 배열을 거부한다 → JSON-RPC batch 요청이 막힌다.
- MCP 클라이언트는 `Accept: application/json, text/event-stream`을 보낸다.

공통 부분을 `readJsonPayload()`로 추출했다. 이 함수는 media type 검사,
`bodyMaxBytes` 제한, `validateJsonShape`를 그대로 수행하고 최상위 타입 판단만
호출자에게 맡긴다. `jsonBody()`는 그 위에서 "객체여야 한다"를 덧붙이고,
`/mcp`는 배열을 허용한 채 그대로 사용한다. 기존 방어 수준은 동일하다.

### 5. method 기반 rate limit

`/mcp`는 handshake, notification, tool 호출이 **한 경로**를 공유한다.
따라서 경로만으로는 비용을 판단할 수 없다.

처음에는 `/mcp`를 `expensive`(기본 12회/분)로 분류했으나, 이 경우 initialize와
tools/list 같은 프로토콜 잡음만으로 예산이 고갈되어 세션이 사용 불가능해졌다.
(테스트가 실제로 `429`를 내며 이 문제를 잡아냈다.)

최종 규칙은 다음과 같다.

- `/mcp` 자체는 `cheap` 예산을 소비한다.
- 본문이 `tools/call`이고 대상이 `expensiveTools`이면 **추가로** `expensive`
  예산을 소비한다.

이로써 REST 경로에 걸려 있던 비용 방어가 MCP 경로에서도 동일하게 유지되면서,
프로토콜 트래픽은 막히지 않는다.

### 6. 감사 로그 correlation id

`mcp_tool_audit.correlation_id`에는 다음 제약이 걸려 있다.

```
correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$'
```

JSON-RPC request id는 보통 `1`, `2` 같은 작은 정수다. 이를 그대로 넘기면
길이 조건(최소 8자)에 걸려 **모든 tool 호출의 감사 기록이 조용히 유실된다.**
초기 구현에서 실제로 `23514` check constraint 위반이 발생했다.

`mcpCorrelationId(sessionId, requestId)`가 `mcp-<sessionId>-<requestId>` 형태로
만들어 길이를 채우고, 동시에 세션 간 request id 충돌도 없앤다.
문자 필터링·64자 절단·8자 패딩을 거쳐 어떤 입력에도 제약을 만족한다.

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `HTTP_HOST` | `127.0.0.1` | 컨테이너에서는 `0.0.0.0` 필요 |
| `PORT` | `8787` | |
| `HTTP_AUTH_MODE` | `off` | 공개 호스팅 시 `token` 필수 |
| `HTTP_AUTH_TOKEN` | — | 32바이트 이상 |
| `MCP_MAX_SESSIONS` | `256` | 동시 세션 상한 |
| `MCP_SESSION_IDLE_MS` | `600000` | idle 세션 회수 기준 |
| `MCP_ALLOWED_HOSTS` | (비어 있음) | DNS rebinding 방어 Host allow-list |
| `MCP_ALLOWED_ORIGINS` | (비어 있음) | 동 Origin allow-list |

`MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS`가 모두 비어 있으면 DNS rebinding
방어는 비활성화된다. 신뢰할 수 있는 proxy 뒤가 아니라면 반드시 설정한다.

## 클라이언트 등록

```json
{
  "mcpServers": {
    "gyeongbuk-public-ai": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer <HTTP_AUTH_TOKEN>" }
    }
  }
}
```

## 검증

`services/mcp-server/src/mcp-http.test.ts` (22개)

- initialize handshake와 세션 id 발급
- stdio와 동일한 tool 목록
- tool 호출이 항상 `data_status`를 동반, demo 데이터 미노출
- 실패한 tool 호출이 `data_status: "empty"`로 응답 (데이터 날조 없음)
- 세션 재사용, DELETE 시 해제
- 알 수 없는 세션 `404`, 세션 없는 비-initialize `400`
- 잘못된 content-type `415`, 미지원 method `405`
- 세션 상한 초과 시 연결 거절, idle 회수, 활성 세션 유지, shutdown drain
- 설정 파싱과 잘못된 값 거절
- correlation id가 감사 제약을 항상 만족
- expensive tool 호출은 `429`가 되지만 `tools/list`는 계속 `200`
- token auth 미제공 시 `401`이며 세션이 생성되지 않음

`services/mcp-server/src/mcp-http.integration.test.ts` (2개, `TEST_DATABASE_URL` gated)

- 실제 PostgreSQL 대상 tool 호출이 `official_observed` structured content 반환
- 감사 로그에 제약을 만족하는 correlation id가 실제로 기록됨

빌드 산출물(`dist/index.js`)로 원격 운영 DB를 대상으로 initialize → notifications/initialized
→ tools/list → tools/call → DELETE 전 구간을 curl로 확인했다.

## 부수 수정: 통합 테스트 timeout

`vitest.config.ts`의 기본 timeout 5초는 원격 PostgreSQL 대상 실행에서 부족했다.
`TEST_DATABASE_URL`을 원격으로 지정하면 변경 전에도 재현되는 기존 문제였다.
(한 lifecycle 테스트는 정상 동작 시에도 약 48초가 걸린다.)

`testTimeout`/`hookTimeout`을 30초로 올려 gated 통합 테스트가 실제로 검증
가능하도록 했다.

## SDK 버전

`@modelcontextprotocol/sdk` 의존 범위를 `^1.17.4` → `^1.30.0`으로 올렸다.
`enableDnsRebindingProtection` 등 이번 구현이 사용하는 옵션이 1.17.x에는 없어,
새 설치가 1.17.x로 해석되면 빌드가 깨질 수 있었다.
