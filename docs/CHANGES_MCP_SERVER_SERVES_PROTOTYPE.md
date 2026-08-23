# 8787이 옛 데모 대신 프로토타입을 보여준다

## 무엇이 문제였나

`services/mcp-server`는 오랫동안 `/`에서 `apps/web/dist`의 정적 데모("경북 데이터
나침반")를 서비스했다. 화면은 이미 `prototype/`의 Next.js 앱으로 옮겨 갔는데,
8787을 열면 여전히 옛 화면이 나왔다. 데모를 보여주는 주소와 실제로 만들고 있는
화면이 갈라져 있었다.

## 왜 파일을 복사하지 않았나

가장 단순한 방법은 프로토타입을 정적으로 뽑아 `apps/web/dist` 자리에 넣는
것이다. 되지 않는다. 프로토타입은 서버 컴포넌트와 `/api/chat`의 SSE 스트리밍을
쓴다. `next export`로는 둘 다 남지 않는다. 뽑아낸 화면은 "보이기만 하고 답하지
않는" 껍데기가 된다.

그래서 파일을 옮기는 대신 **요청을 넘긴다**.

## 어떻게 나누나

```
8787 (mcp-server)
  /health, /ready          이 서버
  /mcp                     이 서버 (프록시하지 않는다)
  SERVER_API_PATHS         이 서버
  /api/tools/<tool>        이 서버 (레지스트리에 있는 이름만)
  그 밖의 전부             PROTOTYPE_ORIGIN
```

`PROTOTYPE_ORIGIN`이 비어 있으면 프록시하지 않는다. 그때 화면 경로는 404이고
MCP와 API만 남는다. Docker 이미지에는 프로토타입이 들어 있지 않으므로 기본이
이 상태다.

## 결정과 이유

### `/mcp`는 넘기지 않는다

프로토콜 종단이다. 세션 헤더(`mcp-session-id`)와 SSE 프레임을 중간에서 다시
조립하기 시작하면, MCP가 잘 도는 것과 도는 척하는 것을 구분할 수 없게 된다.
프록시 분기는 `/mcp` 처리 **뒤**에 있으므로 여기까지 오지 않는다.

### `Host`를 프로토타입 것으로 바꾼다

Next.js는 Host 헤더로 자기 자산 URL을 만든다. 8787의 Host를 그대로 넘기면
브라우저가 없는 주소에서 청크를 찾아 스타일 없는 화면이 뜬다. 원래 주소는
`x-forwarded-for` / `x-forwarded-proto`로 남긴다.

### 본문을 모아 두지 않는다

`/api/chat`은 수십 초 동안 흐르는 SSE다. 버퍼에 담으면 추론 스트림이 끝난 뒤
한꺼번에 도착해서, 기다리는 동안 화면이 비어 있게 된다. 요청·응답 양쪽을
`pipe`로 흘려보낸다. 테스트가 이걸 직접 검사한다 — 첫 청크에 두 번째 이벤트가
들어 있으면 실패한다.

### `startsWith("/api/")`를 명시적 목록으로 바꿨다

예전 코드는 모르는 `/api/*`를 전부 이 서버 것으로 보고 404/401로 돌려보냈다.
그러면 프로토타입의 `/api/chat`이 프록시에 닿지 못한다. 어떤 경로가 서버 것인지
`SERVER_API_PATHS`에 적어 두었다. 무엇이 서버 것이고 무엇이 화면 것인지가
코드에 남는다.

`/api/questions`는 양쪽에 다 있는데 **서버 것이 이긴다**. 프로토타입의 동명
라우트도 결국 MCP 서버로 되물으므로 결과는 같다.

### token 모드와는 같이 못 쓴다 — 시작을 거부한다

`HTTP_AUTH_MODE=token`은 데이터 경로에 토큰을 요구하려고 켜는 것이다. 그런데
화면은 브라우저가 여는 것이라 헤더를 붙일 수 없어서, 프록시 경로는 무인증일
수밖에 없다. 프로토타입의 `/api/chat`도 같은 경로로 열리므로, 토큰을 요구하면서
화면을 얹는 조합은 요구를 스스로 무르는 셈이다.

경고를 찍고 넘어가는 대신 `createHttpApp`이 **던진다**. 조용히 열려 있는 것보다
뜨지 않는 편이 낫다. Docker compose는 token 모드를 강제하지만 `PROTOTYPE_ORIGIN`을
주지 않으므로 영향이 없다.

## 바뀐 것

| 파일 | 내용 |
| --- | --- |
| `services/mcp-server/src/prototype-proxy.ts` | 신규. 설정 파싱, 도달 확인, 스트리밍 프록시 |
| `services/mcp-server/src/prototype-proxy.test.ts` | 신규 11건 |
| `services/mcp-server/src/http.ts` | 정적 파일 서비스 제거, `SERVER_API_PATHS` 도입, 프록시 분기, token 모드 거부 |
| `apps/web/` | 삭제 |
| `pnpm-workspace.yaml` | `apps/*` 제거 |
| `Dockerfile` | `apps` 복사 두 줄 제거 |
| `.env.example` | `PROTOTYPE_ORIGIN` 추가 |
| `README.md` | 실행 절차와 저장소 구조 갱신 |

## 실행

```bash
pnpm --filter @gb/prototype dev                       # 3100
PROTOTYPE_ORIGIN=http://127.0.0.1:3100 pnpm start     # 8787
```

## 확인한 것

측정으로 확인한 항목만 적는다.

- `prototype-proxy.test.ts` 11건 통과, `services/mcp-server` 전체 181건 통과
- `curl http://127.0.0.1:8787/` → 옛 데모가 아니라 프로토타입 스플래시 HTML
- `/_next/static/css/app/layout.css` → 200 (Host 교체가 됐다는 뜻)
- `/mcp` initialize → 세션 발급, `tools/list` → 도구 17개,
  `get_population_trend(봉화군, 2017~2024)` → `official_observed` 실데이터
- `/health`, `/api/questions` → 200, 여전히 서버 것
- `/api/chat` POST → 추론 델타가 토큰 단위로 도착 (09:40:29 stage → 09:40:34 delta),
  한꺼번에 오지 않는다
- CDP 모바일 에뮬레이션(390×844)으로 8787을 열어 6개 화면 렌더 확인, 가로 오버플로 0

## 남은 것

`https://use.me.kr`은 이 저장소 밖의 배포를 가리킨다. 지금도 `/`에서 옛
"경북 데이터 나침반"을 내놓는다. 이 머신에는 터널 프로세스가 없으므로 여기서
고칠 수 없다. 그쪽 배포를 갱신해야 공개 주소에서도 프로토타입이 보인다.
