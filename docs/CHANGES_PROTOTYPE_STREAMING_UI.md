# 프로토타입: 추론 과정 스트리밍과 목업 카드

`prototype/`이 답을 다 만들 때까지 기다렸다가 한 번에 보여주던 방식을 버리고,
진행 중인 일을 그대로 흘려보내도록 바꿨다. 아이콘은 `@phosphor-icons/react`로
옮겼고, 목업에 있던 두 종류의 카드를 답변 스키마에 추가했다.

## 왜 바꿨나

플래너(`gpt-5.6-sol`)와 컴포저(`claude-sonnet-5`)를 차례로 거치므로 질문 하나에
30~45초가 걸린다. 이 시간을 회전하는 점 하나로 때우면 사용자는 서비스가 멈춘
것으로 읽는다. 반대로 그럴듯한 진행 문장을 지어내면 이 프로젝트가 지키려는
"근거 없는 말은 하지 않는다"는 원칙이 화면에서부터 무너진다.

그래서 **실제로 일어난 일만** 내보내기로 했다. 화면에 뜨는 단계와 도구 이름은
모두 서버가 보낸 값이고, 프런트엔드가 만들어 낸 진행 상황은 하나도 없다.

## 무엇이 바뀌었나

### 1. `/api/chat`이 서버-전송 이벤트를 흘려보낸다

단발 JSON 응답을 `text/event-stream`으로 바꿨다(`prototype/src/app/api/chat/route.ts`).
이벤트 순서가 곧 파이프라인의 순서다.

| 이벤트 | 언제 | 담기는 것 |
| --- | --- | --- |
| `stage` | 단계가 시작·완료될 때 | 단계 id, 라벨, 실제 수치(후보 n개, 호출 n건) |
| `tool` | 플래너가 고른 호출마다 | 도구 이름, 데이터셋, 선택 이유 |
| `summary` | 요약 문자열이 닫힌 순간 | 요약 |
| `block` | 카드 하나가 닫힌 순간 | 검증된 블록 |
| `done` | 전부 끝났을 때 | `ChatReply` 전체 |
| `error` | 실패 | 사유 |

`EventSource` 대신 `fetch` + `ReadableStream`을 쓴다. 질문과 페르소나를 POST
본문에 실어야 하기 때문이다(`prototype/src/lib/stream-client.ts`).

### 2. 미완성 JSON에서 완성된 카드만 꺼낸다

컴포저는 블록 배열을 담은 JSON 하나를 쓴다. 배열이 닫히기 전에 카드를 보여주려면
아직 끝나지 않은 텍스트에서 **괄호가 닫힌 객체만** 골라내야 한다.
`prototype/src/lib/stream-json.ts`가 문자열·이스케이프 상태를 들고 다니며
스캔한다. `"title": "{ 중괄호 }"` 같은 값 하나에 스캐너가 어긋나면 그 뒤의
카드를 통째로 잃기 때문이다.

중간에 나가는 블록은 **미리보기**다. 스트리밍이 검증을 건너뛰는 뒷문이 되면
안 되므로, 마지막에 응답 전체를 `answerViewSchema`로 다시 검증하고 화면은
`done` 이벤트의 결과로 교체한다.

진행 상태는 `localStorage`에 저장하지 않는다. 새로고침 후에 남은 반쪽짜리 추론
과정은 아무 의미가 없고, 완료된 답만 다시 열어 볼 가치가 있다.

### 3. 목업의 카드 두 종류를 스키마에 추가

- `briefing` — 좌우 2단 카드. 왼쪽은 사람의 조건(나이·지역·업종)에 대한 해당
  여부를 이어 읽고, 오른쪽은 칸마다 끊어 읽는다. 목업의 `PERSONA BRIEFING`.
- `scenario` — 전제를 고르는 추정 카드. 선택지 칩, 강조된 막대, 주석으로 이뤄진다.
  각 선택지의 값이 근거에 있을 때만 쓰라고 프롬프트에서 못 박았다.

`scenario.bars[].ratio`는 0~1로 제한한다. 범위를 벗어난 막대는 카드를 뚫고
나가므로, 잘못된 축척으로 그리느니 그 블록만 버린다.

### 4. 아이콘을 `@phosphor-icons/react`로

`lucide-react`를 지우고 목업과 같은 획으로 맞췄다. 아바타는 `Ghost`,
사이드바는 `MagnifyingGlass`/`ChatCircleDots`/`FolderSimple`/`BookOpen`/`Trash`/`Gear`,
입력창은 `Plus`/`Microphone`/`Waveform`/`ArrowUp`이다.

서버 컴포넌트(`/guide`)에서는 `@phosphor-icons/react/dist/ssr`을 써야 한다.
기본 진입점이 리액트 컨텍스트를 쓰기 때문에 `createContext is not a function`으로
빌드가 멈춘다.

## 확인한 것

- `pnpm --filter @gb/prototype typecheck`, `pnpm --filter @gb/prototype build` 통과
- `npx vitest run prototype` 28건 통과(`stream-json` 7건, `blocks` 9건 포함)
- 종단 실행: `planner=llm:gpt-5.6-sol`, `composer=claude-sonnet-5`, `degraded=null`,
  블록 `headline / series / metric / callout / briefing / bullets`
- headless Chrome으로 진입·질문·대화 화면 캡처. 대화 화면에서 8초 시점에 이미
  완료된 두 단계와 고른 도구 두 건, 경과 시간이 떠 있는 것을 확인했다.

## 남은 것

`scenario` 블록은 근거에 여러 전제의 값이 함께 있을 때만 나온다. 지금 카탈로그의
도구들은 그런 형태를 잘 만들지 않아 실제 출력에서 아직 관측하지 못했다.
시나리오형 도구가 붙으면 다시 확인해야 한다.
