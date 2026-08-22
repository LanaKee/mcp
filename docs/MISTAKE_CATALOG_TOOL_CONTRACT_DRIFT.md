# 실수: 카탈로그가 도구에 거짓 계약을 광고하고 있었다

## 무슨 일이 있었나

`packages/domain/src/catalog.ts`의 각 데이터셋은 어떤 도구로 읽는지와 그 도구가
요구하는 인자를 `requiredArguments`로 선언한다. 에이전트 플래너는 이 선언을 계약으로
믿고 계획을 만든다.

그런데 두 곳에서 선언이 실제 스키마와 달랐다.

| 도구 | 카탈로그 선언 | 실제 zod 스키마 |
| --- | --- | --- |
| `search_member_bills` | `[]` | `member` 또는 `query` 중 하나 필수 (refinement) |
| `search_policies` | `["region", "query"]` | `region`, `age`, `query` 모두 필수 |

결과적으로 **플래너가 카탈로그를 완벽히 따라도 도구가 거부하는 호출**이 만들어졌다.
LLM 플래너는 `search_member_bills`를 인자 `{}`로 호출했고, 도구는
"member 또는 query 중 하나는 반드시 지정해야 합니다"로 거부했다.

## 왜 놓쳤나

세 가지가 겹쳤다.

1. **카탈로그를 손으로 썼다.** 도구 스키마와 카탈로그 선언이 서로 다른 파일에 있고
   둘을 연결하는 검사가 없었다.
2. **결정론적 플래너가 우연히 이를 가렸다.** `HeuristicPlanner.argumentsFor`는
   `search_member_bills`에 항상 `{query, limit}`을 넣는다. 그래서 heuristic
   벤치마크는 통과했고 결함이 보이지 않았다.
3. **`validateStep`이 존재만 확인했다.** `undefined`/`null`이 아니면 통과시켰다.
   `age` 누락은 카탈로그가 필수라고 말하지 않았으므로 검사되지 않았고,
   `query: ""`는 "존재"하므로 통과했다.

즉, 카탈로그와 도구 사이에 **검증되지 않은 인터페이스**가 있었고, 결정론적 경로가
그것을 우회하고 있어서 LLM 경로에서만 드러났다.

## 어떻게 드러났나

두 플래너로 같은 벤치마크를 따로 돌렸기 때문이다.

```
heuristic       15/15
llm:gpt-4o-mini 12/15   <- bill-member-proposal 실패
```

점수를 하나로 합쳤다면 "모델이 가끔 틀린다"로 넘어갔을 것이다. 플래너를 분리한
덕분에 **모델이 아니라 카탈로그가 틀렸다**는 것이 특정됐다.

## 무엇을 고쳤나

### 1. 선언을 실제와 맞췄다

```ts
// search_member_bills
requiredArguments: ["query"]        // 표현 가능한 것 중 약한 쪽
// search_policies
requiredArguments: ["region", "age", "query"]
```

`search_member_bills`의 either-or는 문자열 배열로 표현할 수 없어, 만족하면 반드시
통과하는 쪽(`query`)을 택했다.

### 2. 계약을 테스트로 고정했다

`services/mcp-server/src/catalog-tools.test.ts`:

> 모든 데이터셋의 모든 바인딩에 대해, `requiredArguments`만 채운 입력이 그 도구의
> zod 스키마를 통과해야 한다.

이 테스트를 쓰자마자 `search_policies`의 `age` 누락이 즉시 드러났다. 한 번의
수정으로 끝날 문제가 아니라 **클래스로 막아야 하는 문제**였다는 증거다.

### 3. 안전 경계가 도구 자신의 파서를 쓰게 했다

`validateStep`이 자체 규칙 대신 `registry.tools[step.tool].parse(...)`를 호출한다.

```ts
try {
  registry.tools[step.tool]!.parse(step.arguments);
} catch (caught) {
  return `${step.tool} 인자가 도구 스키마를 통과하지 못했습니다: ...`;
}
```

병렬 규칙 집합은 언젠가 반드시 어긋난다. 같은 검증기를 쓰면 어긋날 수 없다.
빈 문자열도 누락으로 취급하도록 `isBlank`를 추가했다.

## 교훈

- **선언이 계약이면, 계약은 테스트되어야 한다.** 메타데이터가 코드의 동작을
  좌우하는 순간 그 메타데이터는 문서가 아니라 인터페이스다.
- **경계 검증은 원본 검증기를 재사용해야 한다.** 검증 로직을 복제하면 두 벌이
  서서히 갈라진다.
- **결정론적 경로가 통과한다고 인터페이스가 옳은 것은 아니다.** 특정 호출자가
  우연히 올바른 인자를 항상 넣고 있으면 결함이 숨는다. 다른 성격의 호출자(LLM)를
  같은 인터페이스에 붙여본 것이 결정적이었다.
