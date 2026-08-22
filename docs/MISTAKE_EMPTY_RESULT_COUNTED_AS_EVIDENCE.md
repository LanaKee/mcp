# 실수: 결과가 0건인 도구 호출을 근거로 집계했다

## 증상

웹 데모에서 「도의회에서 지방소멸을 다룬 의안을 찾아줘」를 물었더니 이렇게 답했다.

```
answered:  true
conclusion: "도의원 발의 의안에서 근거를 수집했습니다."
evidence:  1건
sources:   0건
```

**출처가 0건인데 "근거를 수집했다"고 말했다.** 이 프로젝트가 존재하는 이유가
"모든 문장에 출처를 붙인다"인데, 정확히 그 반대를 했다.

## 왜 생겼나

두 개의 독립된 결함이 겹쳐 있었다.

### 결함 1 — `search_member_bills`가 무관한 의원 명부를 반환했다

의안 검색은 두 개의 질의로 되어 있다. 하나는 의원 명부, 하나는 의안. 그런데 의원
명부 질의는 `member`/`party` 필터만 볼 뿐 **`query`를 전혀 보지 않았다.**

그래서 "지방소멸"로 검색하면 일치하는 의안이 0건인데도 도의원 64명이 그대로
반환됐다. 호출자 입장에서 이것은 "결과가 나왔다"로 읽힌다.

게다가 `council_member`는 `source_id`와 `data_status`를 가진 정식 테이블인데,
`sources`와 `dataStatuses`는 **의안 행에서만** 유도하고 있었다. 즉 반환된 의원
64명은 **출처가 하나도 붙지 않은 데이터**였다.

### 결함 2 — 에이전트가 빈 응답을 근거로 취급했다

`runAgent`는 도구 호출이 예외를 던지지 않으면 무조건 근거로 기록했다.

```ts
sources.push(...response.sources);   // 빈 배열이어도 그대로
evidence.push({ ... });              // 무조건 추가
...
const answered = evidence.length > 0;   // -> true
```

필터에 걸리는 행이 하나도 없는 검색은 **예외가 아니라 정상적인 빈 결과**다.
`data_status`는 `"empty"`, `sources`는 `[]`가 된다. 이 경우를 구분하지 않았기
때문에 "성공했다"가 "근거가 있다"로 둔갑했다.

## 고친 방법

### 에이전트: 빈 응답은 근거가 아니다

```ts
if (response.data_status === "empty" || response.sources.length === 0) {
  rejectedSteps.push({ step, reason: "...조건에 맞는 데이터가 없어 근거로 쓰지 않았습니다." });
  limitations.add(`${dataset.title}에서 조건에 맞는 기록을 찾지 못했습니다.`);
  continue;
}
```

거부된 호출로 기록하므로 화면의 「에이전트 경로」에 "무엇을 시도했고 왜 실패했는가"가
그대로 남는다. 조용히 범위를 좁히는 것보다 낫다.

### 저장소: 명부를 실제 발의자로 한정하고 출처를 붙였다

주제어 질의는 "어떤 의안인가"를 묻는 것이므로, 명부는 **그 의안을 발의한 사람들**을
설명해야 한다.

한 가지 함정이 있었다. 처음에는 이미 가져온 명부를 발의자 ID로 **필터링**하려 했는데,
명부 질의에 `LIMIT`이 걸려 있어서 그 창 밖에 있는 실제 발의자가 조용히 사라진다.
그래서 필터링 대신 **발의자 ID로 다시 조회**하도록 했다.

```ts
// Re-queried rather than filtered: the unrestricted roster is capped,
// so filtering it would silently drop sponsors outside that window.
reportedMembers = await this.loadCouncilMembers({ memberIds: sponsorIds });
```

명부 질의는 `loadCouncilMembers`로 추출하면서 `data_source`를 조인해 각 의원이
자신의 출처를 갖도록 했다.

### 순서를 잘못 밟았던 점

출처 부착을 **먼저** 하고 명부 한정을 나중에 했더니, 중간 상태에서 에이전트의
`sources.length === 0` 검사가 무력화됐다. 의원 명부에 출처가 붙는 순간 "출처 0건"이
아니게 되어, 의안 0건인 응답이 다시 근거로 통과했다.

**증상을 감지하는 신호(출처 0건)를 없애는 수정을, 원인(무관한 명부 반환)을 고치기
전에 넣은 것**이 문제였다. 두 수정 사이에 잠깐 존재한 상태가 처음보다 더 나빴다.

## 검증

```
search_member_bills query="지방소멸"  -> status empty,  members 0,  bills 0, sources 0
search_member_bills query="인구"      -> status official_observed, members 18, bills 3, sources 2
search_member_bills member="허복"     -> status official_observed, members 1,  bills 3, sources 2
```

에이전트:

```
"도의회에서 지방소멸을 다룬 의안을 찾아줘"  -> answered false, 거부 사유 기록
"도의회에서 인구 관련 의안을 찾아줘"        -> answered true, 근거 1, 출처 2
```

회귀 테스트 두 개를 추가했다.

- 0건을 반환한 도구 호출이 근거로 집계되지 않고 거부 목록에 남는지
- 답변된 모든 질문에서, 근거가 인용한 모든 `sourceId`가 같은 답변의 `sources`에
  실제로 존재하는지 (기존에는 인구 질문 하나에만 걸려 있던 검사)

전체 298 passed / 47 skipped. 벤치마크는 두 플래너 모두 15/15 유지.

## 교훈

- **"예외가 없었다"는 "결과가 있었다"가 아니다.** 빈 결과는 정상 경로이므로 명시적으로
  구분해야 한다.
- **반환하는 모든 것이 데이터다.** 부수적으로 딸려 나가는 명부도 출처를 가져야 한다.
  주 엔티티에만 provenance를 붙이면 나머지는 출처 없는 주장이 된다.
- **결함을 드러내는 신호를 먼저 지우지 말 것.** 원인부터 고치고 그 다음에 표면을
  정리해야 한다.
- **캡이 걸린 목록을 사후 필터링하면 안 된다.** 조건을 질의로 내려보내야 한다.
