# 변경: 플래너 모델을 이름으로 지정한다 (`PLANNER_MODEL`)

## 배경

`chatClientFromEnv`는 **키 존재 순서**로 공급자를 골랐다.

```ts
if (env.OPENAI_API_KEY) { ... }   // 여기서 끝난다
if (env.GROK_API_KEY) { ... }
if (env.GEMINI_API_KEY) { ... }
if (env.CLAUDE_API_KEY) { ... }
```

네 공급자의 키를 모두 가진 개발 환경에서는 OpenAI의 기본값(`gpt-4o-mini`)이 항상
이겼고, 나머지 세 공급자는 코드를 고치지 않는 한 도달할 수 없었다. 공급자별
`*_PLANNER_MODEL`도 있었지만 그것은 "OpenAI를 쓸 때 어떤 OpenAI 모델을 쓸지"를
정할 뿐, "어느 모델로 계획할지"를 말하지 못한다.

역할이 둘로 나뉜 지금은 이게 더 분명한 문제다.

| 역할 | 하는 일 | 모델 |
| --- | --- | --- |
| 플래너 | 카탈로그 후보에서 **어떤 도구를 어떤 인자로 부를지** 결정 | `PLANNER_MODEL` |
| 컴포저 | 이미 모인 근거를 **화면 카드로 배치** | `PROTOTYPE_MODEL` |

## 무엇을 바꿨나

`PLANNER_MODEL`이 있으면 모델 id로 공급자를 역추론해(`chatClientFor`) 그 모델을
쓰고, 키 순서 분기는 건너뛴다.

```bash
PLANNER_MODEL=gpt-5.6-sol       # 도구 선택
PROTOTYPE_MODEL=claude-sonnet-5 # 화면 구성
```

이름이 잘못됐거나 해당 공급자의 키가 없으면 **서버를 죽이지 않고** 경고를 남긴 뒤
기존 키 순서 선택으로 내려간다. 그것마저 없으면 결정적 플래너가 남는다. 모델은
언제나 업그레이드지 요구사항이 아니다.

## 검증

- `services/mcp-server/src/llm-planner.test.ts` 31건 통과. 새로 추가한 것:
  - 키가 넷 다 있어도 `PLANNER_MODEL`이 이긴다.
  - 모델 id로 공급자를 찾아간다(`gpt-5.6-sol` → OpenAI).
  - 키가 없거나 id가 이상하면 키 순서 선택으로 내려간다.
- 실제 기동: `Agent planner: llm:gpt-5.6-sol`
- 종단 실행(포항시 인구·세수): 플래너가 `get_local_tax_revenue_trend`와
  `get_population_trend`를 골라 호출하고, 컴포저(`claude-sonnet-5`)가 헤드라인·지표
  두 장·경고·시계열·주의사항 카드로 배치했다. 세수는 관측 시점이 하나뿐이라
  증감을 판정하지 않았다.

## 주의

추론 계열 모델은 계획 한 번에 수십 초가 걸린다(위 실행은 종단 40초). HTTP 서버의
`HTTP_EXPENSIVE_OPERATION_TIMEOUT_MS`를 좁게 잡은 배포에서는 플래너 모델을 바꾸기
전에 그 값을 함께 확인해야 한다.
