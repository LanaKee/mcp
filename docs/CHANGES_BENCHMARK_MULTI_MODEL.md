# 벤치마크 다중 모델 실행 (gpt-5.6-luna / claude-sonnet-5 / gemini-3.6-flash)

## 배경

`benchmark/`는 `gpt-4o-mini` 한 모델로만 측정되어 있었습니다. 단일 모델 결과는
"MCP 계층이 도움이 된다"는 주장을 뒷받침하기에 약합니다. 관측된 차이가 데이터
계층 때문인지, 그 모델 하나의 특이한 습성 때문인지 구분할 수 없기 때문입니다.
서로 다른 공급자의 모델 세 개를 추가로 측정하여 이를 분리했습니다.

## 결과 요약

전체 표는 `benchmark/reports/COMPARISON.md`에 있습니다.

| 모델 | vanilla 정확도 | MCP 정확도 | 변화 |
| --- | ---: | ---: | ---: |
| `gpt-4o-mini` | 27.3% | 72.7% | +45.5p |
| `gpt-5.6-luna` | 36.4% | 81.8% | +45.5p |
| `claude-sonnet-5` | 50.0% | 81.8% | +31.8p |
| `gemini-3.6-flash` | — | — | 측정 불가 (아래 참조) |

유효한 실행 3개 모두에서 MCP arm이 더 정확했습니다.

## 이번 실행으로 드러난 것 — 기존 결론의 수정

`gpt-4o-mini` 단독 측정에서는 **"vanilla의 지배적 실패는 환각이 아니라 침묵"**
이라고 결론지었습니다. 이 결론은 모델 일반의 성질이 아니라 그 모델의 성질이었습니다.

| 모델 | vanilla 답변 시도율 | vanilla 환각률(답변 대비) |
| --- | ---: | ---: |
| `gpt-4o-mini` | 27.3% | 33.3% |
| `gpt-5.6-luna` | 100.0% | 63.6% |
| `claude-sonnet-5` | 100.0% | 50.0% |

강한 모델은 침묵하지 않습니다. **전부 답하고, 답한 것의 절반 이상을 지어냅니다.**
`gpt-5.6-luna`는 22문항 전부에 답하며 그중 63.6%가 사실과 달랐습니다.

이는 프로젝트의 가치 서술을 강화합니다. 모델이 커지면 근거 계층이 덜 필요해지는
것이 아니라, 오히려 실패가 눈에 덜 띄는 형태(자신 있는 오답)로 바뀌므로 **검증
가능한 출처를 붙이는 일이 더 중요해집니다.** vanilla의 출처 검증 가능 비율은 세
모델 모두 0.0%입니다. 출처를 대지 않아서가 아니라, 대는 출처가 실재하지 않기
때문입니다.

## gemini-3.6-flash를 측정하지 못한 이유

무료 등급 할당량이 **모델당 하루 20건**인데 1회 실행에는 44건(22문항 × 2 arm)이
필요합니다. 지수 백오프 재시도를 넣어도 일일 한도는 해소되지 않습니다.

```
"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
"limit: 20, model: gemini-3.6-flash"
```

같은 계열의 `gemini-3.5-flash`(별도 할당량)로도 시도했으나 11번째 문항에서 동일한
한도에 걸렸습니다. **유료 등급 키 없이는 Gemini 계열을 이 벤치마크로 측정할 수
없습니다.** 실패한 실행은 삭제하지 않고 `reports/gemini-3.6-flash/`에 무효 표시와
함께 남겨 두었습니다. 시도한 사실 자체가 기록될 필요가 있기 때문입니다.

## 구현 변경

### services/mcp-server/src/llm-planner.ts

- **`chatClientFor(model, env, options)` 추가.** 기존 `chatClientFromEnv`는 키
  우선순위 체인이라 `OPENAI_API_KEY`가 설정되어 있으면 Gemini·Claude에 **도달할 수
  없었습니다.** 모델을 비교하려면 모델을 직접 지정할 수 있어야 합니다. 공급자는
  모델 id에서 추론합니다(`providerForModel`).
- **`AnthropicChat` 추가.** `.env`에 `CLAUDE_API_KEY`가 있었지만 클라이언트가
  없었습니다. `max_tokens`가 필수이고 응답이 블록 배열인 점이 다른 두 공급자와
  다릅니다. `thinking` 블록을 걸러내지 않으면 모델의 사고 과정을 답변으로 채점하게
  됩니다.
- **temperature 자가교정.** `gpt-5.6-luna`와 `claude-sonnet-5`는 `temperature`를
  아예 거부합니다. 모델별 표를 두면 신모델이 나올 때마다 낡으므로, 400 응답이
  temperature를 지목하면 값을 빼고 1회 재시도합니다. 이 경우 실행이 재현 불가능해
  지므로 리포트에 `temperaturePinned: false`로 기록합니다.
- **`GeminiChat`의 thought part 제거.** thinking 모델은 첫 part가 사고 과정일 수
  있는데 기존 코드는 `parts[0].text`를 그대로 반환했습니다.
- **전송 실패 재시도(`retryDelayMs`).** rate limit은 모델의 능력이 아니라 계정
  할당량의 문제이므로 오답으로 기록되면 안 됩니다. 단 **기본값은 재시도 0회**입니다.
  서버는 결정론적 플래너로 빠르게 폴백해야 하므로 30초씩 멈추면 안 되며, 재시도는
  배치 실행이 명시적으로 옵트인합니다.

### benchmark/

- `--model` 플래그. 리포트는 `reports/<모델명>/`으로 분리되어 서로 덮어쓰지 않습니다.
- `src/compare-models.ts` + `reports/COMPARISON.md`. **API 실패율 10%를 넘는 실행은
  점수표에서 제외**하고 실행 조건표에만 무효로 남깁니다.
- 지속적 호출 실패 시 조기 중단(`CONSECUTIVE_FAILURE_LIMIT`). 6회 연속 실패하면
  리포트를 남기지 않고 멈춥니다.
- 추론 모델을 위해 타임아웃 30초 → 180초.

## 검증

- `pnpm typecheck`, `pnpm build` 통과
- 신규 테스트 18건 포함 전체 테스트 통과
- `benchmark/reports/COMPARISON.md`의 주장은 하드코딩이 아니라 실행 데이터에서
  도출됩니다. 실제로 "지연은 항상 MCP가 느리다"는 초안의 문장은 `gpt-5.6-luna`
  실측(vanilla 7,143ms > MCP 3,951ms)과 어긋나 제거했습니다.

## 남은 한계

- 모델 간 **절대 점수 비교는 유효하지 않습니다.** 22문항은 순위를 매기기에 너무
  적고, 두 모델은 temperature를 고정할 수 없어 재현성이 낮습니다. 읽어야 할 값은
  각 모델 *내부*의 vanilla → MCP 변화량입니다.
- 실행별 변동이 있습니다. `gpt-4o-mini`는 동일 조건 재실행에서 정확도가
  18.2% → 27.3%로 움직였습니다.
- Gemini 계열은 유료 키 확보 전까지 미측정입니다.
