# 서술 코퍼스 라우팅과 자기모순 계획 처리

프로토타입을 네이티브 MCP로 전환하기 전에, 프롬프트 플래너 경로에서 발견한 세 가지 결함을 고친 기록이다. `/api/agent`는 벤치마크와 MCP 클라이언트가 없는 소비자를 위해 남아 있으므로 이 수정은 여전히 유효하다.

## 1. 주제어가 서술 코퍼스에 닿지 못했다

`isDatasetRelevant`는 큐레이션된 어휘와 질의어를 양방향 부분문자열로 맞춘다. 측정 테이블은 주제가 고정돼 있어 이 게이트가 맞다.

문제는 전문 코퍼스다. `press_release`의 keywords는 **형식어뿐**이다 — 보도자료·발표·도정·홍보·브리핑. 코퍼스는 "도가 발표한 무엇이든"이라 고정된 주제가 없으니 당연한 결과다. 그래서 "스마트팜 창업 지원사업"은 이 게이트를 절대 통과하지 못했다. 실제로 322건이 적재돼 있어도 후보에 오르지 않았다.

`services/mcp-server/src/catalog-tools.ts`에서 완화했다. 다만 조건을 좁게 잡았다.

```ts
if (relevant.length > 0 && hasTopicalTerm(input.query)) { ... }
```

- **게이트가 이미 주제를 인정했고**, 그 후보의 표가 **전부 비어 있을 때만** 코퍼스를 후보에 넣는다
- 카탈로그가 아예 알아보지 못한 질의는 여전히 0건이다. 그때 코퍼스를 넣으면 "아무것도 아닌 질문에 대한 임의의 top-N"이 되고, 그것이 이 도구가 막으려는 실패다
- 코퍼스는 `lexicalSearch` 랭킹을 거치지 않고 명시적으로 append한다. 카탈로그 **설명문**을 랭킹하면 조사 "에서" 같은 우연한 겹침이 순서를 정해 버린다

코퍼스는 `narrative_context_only`라 수치 주장을 뒷받침할 수 없으므로, 오탐의 최악은 "0건 매칭"을 보고하는 것이다.

`packages/domain/src/catalog.ts`에 헬퍼 두 개를 더했다. `isNarrativeCorpus`와 `hasTopicalTerm`(지리어·조사 외에 실제 주제어가 있는지). `hasTopicalTerm`은 기존 `isGeographicTerm`을 재사용한다 — 지명만으로 데이터셋이 관련돼 보이는 것을 막는 기존 방어를 그대로 잇기 위해서다.

## 2. 플래너가 일을 계획해 놓고 거부를 선언했다

플래너가 실행 가능한 단계를 세운 **동시에** `unanswerable`을 채워 돌려주는 경우가 있었다. "자격 판정은 불가"를 "답변 불가"로 뭉갠 것이다. `agent.ts`의 조기 반환 브랜치가 이것을 보고 `evidence: []`로 근거를 통째로 버렸다.

- 프롬프트에 규칙 8·9를 더했다. `unanswerable`은 **어떤 후보도 아무것도 기여할 수 없을 때만**이며, `steps`가 비어 있지 않으면 반드시 null이다. 부분적인 답은 실패가 아니다
- 프롬프트만 믿지 않고 코드에도 안전망을 두었다. `plan()` 말미에서 실행 가능한 단계가 있는데 `unanswerable`이 채워져 있으면, 거부를 `caveat`으로 강등하고 단계는 실행한다
- `AgentPlan.caveat`을 추가하고 `agent.ts`가 그것을 `limitations`에 넣는다. 모델이 밝힌 한계는 버리지 않고 답에 남는다

## 3. HTTP 타임아웃이 플래너 호출을 감당하지 못했다

`HTTP_EXPENSIVE_OPERATION_TIMEOUT_MS` 기본값이 12초였다. `/api/agent`는 추론 모델 호출을 포함해 30~45초가 걸리므로 청년정책 질문이 504로 죽었다. `.env.example`을 올렸다.

```
HTTP_REQUEST_TIMEOUT_MS=120000
HTTP_HEADERS_TIMEOUT_MS=20000
HTTP_CHEAP_OPERATION_TIMEOUT_MS=8000
HTTP_EXPENSIVE_OPERATION_TIMEOUT_MS=90000
```

## 테스트

`catalog-tools.test.ts`에 두 건, `llm-planner.test.ts`에 한 건을 더했다.

- 게이트가 알아본 주제의 표가 비면 코퍼스가 후보에 들어온다
- 표에 행이 있으면 코퍼스는 들어오지 않는다 (완화는 구제이지 기본값이 아니다)
- 어휘가 겹치지 않는 질의는 **여전히** 0건이다
- 단계와 거부를 함께 담은 계획은 단계를 실행하고 거부를 한계로 남긴다

`services/mcp-server`와 `packages` 전체 246건 통과.
