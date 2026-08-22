# 지역 근거 컴파일러: 통계·정책·의회 자료를 하나의 검증 묶음으로

## 배경

이전까지 이 프로젝트는 "질문 하나에 도구 하나"였다. 인구를 물으면 인구를,
의안을 물으면 의안을 돌려줬다. 그러나 실제 지역 문제 조사에서 필요한 것은
개별 수치가 아니라 **"이 주장을 뒷받침할 자료가 무엇이고, 무엇이 없는가"**이다.

이번 변경의 목표는 검색 시간이 아니라 **검증에서 행정 행동까지 걸리는 시간**을
줄이는 것이다. 그래서 도구 개수를 늘리는 대신, 지역 문제 조사라는 하나의 복합
워크플로를 MCP-native하게 제공한다.

## 1. `build_regional_evidence_pack`

`services/mcp-server/src/evidence-pack.ts`

지역·현안·기간을 받아 고정된 6개 데이터셋 프로브를 모두 실행하고, 결과를
`supporting` / `contextual` / `gaps` 로 분류한 묶음을 반환한다.

핵심 설계는 **프로브 목록이 모델이 아니라 코드에 고정**되어 있다는 점이다.
근거 묶음은 "무엇이 있는가"뿐 아니라 **"무엇이 없는가"에 대한 주장**이기도
하다. 모델이 데이터셋을 건너뛸 수 있다면 "자료 없음"은 데이터의 상태가 아니라
모델의 선택을 반영하게 되고, 그 순간 근거 공백은 증거로서 쓸모가 없어진다.

프로브는 두 종류로 나뉜다.

| 종류 | 필터 | 이유 |
| --- | --- | --- |
| 통계 프로브 | `region` 구조화 필터 | 인구·지방세는 시군 단위로 정규화되어 있다 |
| 서술 프로브 | 본문 텍스트 `${region} ${issue}` | 보도자료 13,707건이 전부 도 단위로 태깅되어 있어 시군 필터로는 0건이 된다 |

서술 프로브가 텍스트 매칭이라는 사실은 결과의 `limitations`에 명시된다.
사용자가 그 차이를 모르면 두 결과를 같은 강도의 근거로 오해하기 때문이다.

### 근거 공백(gap) 규칙

`deriveGaps()`가 네 가지 규칙으로 공백을 도출한다. 공백은 "검색 실패"가 아니라
**행정 행동의 근거**로 취급된다. 성과·집행 데이터가 없다는 사실 자체가
정보공개청구의 사유가 되기 때문이다.

### `search_documents` 추가

카탈로그는 `document_chunk`를 업무계획·본문 같은 키워드로 광고하면서도, 유일한
바인딩인 `get_source_context`는 아직 모르는 source id를 요구했다. 즉 검색으로는
도달할 수 없는 데이터셋이었다. 본문 검색 도구를 추가해 이 모순을 해소했다.

## 2. `compare_peer_regions`

`packages/domain/src/analytics.ts`

같은 방식으로 측정된 구간만 골라 유사 시군을 비교한다. 측정 기준이 다른 구간은
비교 대상에서 제외하고, **제외 사유를 결과에 함께 반환한다**. 조용히 빼면
사용자는 그 지역에 데이터가 없다고 오해한다.

설계 경위와 두 번의 실패는 `MISTAKE_PEER_COMPARISON_SCOPE.md`에 정리했다.

## 3. `trace_policy_response`

`services/mcp-server/src/policy-timeline.ts`

현안과 관련된 계획·발표·심의·의안을 시간순으로 정리한다. 두 가지 규칙이 있다.

- **단계는 출처 데이터셋에서 정해지고, 문장 표현에서는 절대 정해지지 않는다.**
  "완료했다"고 쓴 보도자료는 여전히 발표(announcement)이지 성과가 아니다.
- **`outcomeAssessment`는 항상 `null`이며, 그 옆에 이유가 붙는다.** 필드를
  없애면 "성과를 판정하지 않는다"는 사실이 화면에서 사라진다. 비어 있는 값이
  아니라 **비워 둔 이유가 있는 값**이어야 한다.

## 4. MCP Resource / Prompt

`services/mcp-server/src/mcp-resources.ts`, `mcp-prompts.ts`

"왜 굳이 MCP인가"에 대한 답이다. 도구 호출은 클라이언트 하나에서 끝나는 사적인
사건이지만, 리소스는 주소를 가진다. 두 개의 AI 클라이언트가 같은 URI를 읽으면
같은 근거 묶음 위에서 추론한다.

```
gyeongbuk://datasets
gyeongbuk://datasets/{id}
gyeongbuk://regions/{region}/evidence?issue=...
gyeongbuk://sources/{sourceId}
```

Prompt는 `investigate_regional_issue`, `draft_civic_action` 두 개다. 어떤 MCP
클라이언트에서도 동일한 조사 절차가 재현되도록 한다.

## 5. `draft_evidence_backed_action`

근거 묶음을 정보공개청구서 / 주민참여예산 제안서 초안으로 컴파일한다.

문서는 **서버에서 생성한다**. "검증된 내용만 제출된다"는 보장을 편집 가능한
클라이언트 코드가 강제하게 두면 보장이 아니기 때문이다. 정보공개청구서는
`gaps`에서, 주민참여예산 제안서는 관측된 통계에서 만들어지며, 관측 통계가 전혀
없으면 제안서 생성을 **거부**한다.

## 6. 근거 그래프 UI

`apps/web/src/index.html`, `app.js`, `styles.css`

카드 목록 대신 근거 사슬을 열(column) 구조로 그린다. 각 노드에 출처 위치,
기준일, 공식성, 데이터 상태, **그 자료가 할 수 있는 주장과 할 수 없는 주장**을
표시한다. 이미 구현된 `sources` / `limitations` / `data_status`를 가장 눈에 띄게
보여주는 방식이다. 하단에는 타임라인과 문서 다운로드 버튼이 붙는다.

## 검증

- `pnpm --filter @gb/mcp-server exec vitest run` — 164 passed / 34 skipped
- `pnpm --filter @gb/domain exec vitest run` — 46 passed
- `pnpm typecheck`, `pnpm --filter @gb/web build` 통과
- 운영 PostgreSQL 대상 벤치마크: heuristic 15/15, llm 15/15, 11개 지표 전부 100%

## 관련 커밋

| 커밋 | 내용 |
| --- | --- |
| `fc76625` | 근거 묶음, 공백, 그로부터 정당화되는 행동 |
| `6b5ec6e` | 실제로 같은 측정일 때만 유사 시군 비교 |
| `14fdbe2` | 성과 판정 없이 행정 기록을 시간순으로 |
| `fef6964` | 주소를 가진 MCP 리소스와 프롬프트 |
| `920b923` | 근거 사슬 렌더링과 공백의 문서화 |
