# 실수: 화면 스키마의 상한을 거절 사유로 썼다

## 무엇을 했나

프로토타입에서 모델이 내는 답변을 블록 JSON으로 받고 zod로 검증하도록 만들었다.
그때 상한을 이렇게 적었다.

```ts
items: z.array(longText).min(1).max(8)   // bullets
blocks: z.array(blockSchema).min(1).max(8)
```

검증에 실패하면 응답 전체를 버리고 결정적 폴백 렌더러로 그리게 했다.

## 무엇이 잘못됐나

첫 종단 실행에서 바로 폴백으로 떨어졌다.

```
composer deterministic
degraded 모델 응답이 화면 스키마를 벗어났습니다: blocks.5.items Array must contain at most 8 element(s)
```

모델은 헤드라인, 지표 그리드, 시계열, 표, 경고를 정확히 만들어 놓고 마지막
「해석 시 주의」 목록에 항목을 아홉 개 썼다. 그 한 줄 때문에 나머지 다섯 블록이
전부 버려졌다.

상한은 **화면이 감당할 수 있는 범위**를 적은 것이지, 답변이 틀렸다는 신호가 아니다.
그런데 코드는 두 가지를 같은 실패로 취급했다. 결과적으로 화면 품질이 모델이 쓴
가장 사소한 초과 한 건에 묶였다.

같은 실수의 일반형: **표현상의 제약을 정합성 제약과 같은 층에서 처리한 것**이다.
"근거에 없는 수치"는 반드시 막아야 하지만, "항목이 하나 많다"는 잘라내면 그만이다.

## 어떻게 고쳤나

상한을 보정 지점으로 바꿨다.

```ts
const text = (max: number) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim().slice(0, max) : v), z.string().min(1));

const list = (schema, max, min = 1) =>
  z.preprocess((v) => (Array.isArray(v) ? v.slice(0, max) : v), z.array(schema).min(min));
```

블록 배열은 개별 파싱에 실패한 항목만 걸러낸다.

```ts
z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((item) => blockSchema.safeParse(item).success).slice(0, 8) : v),
  z.array(blockSchema).min(1)
);
```

살아남은 블록이 하나도 없을 때만 폴백으로 간다. 고친 뒤 같은 질문에서
`composer=claude-sonnet-5`, `degraded=null`로 카드가 그려졌다.

## 남긴 기준

- 스키마 위반을 두 종류로 나눈다. **잘라서 받아들일 것**(길이·개수)과
  **버려야 할 것**(정의되지 않은 블록, 필수 필드 누락, 점이 하나뿐인 시계열).
- 폴백은 부분 실패가 아니라 전면 실패에만 쓴다.
- 프롬프트에도 상한을 명시한다. 보정에 기대는 것과 알려주지 않는 것은 다르다.

## 회귀 테스트

`prototype/src/lib/blocks.test.ts`

- 항목 12개짜리 `bullets`는 8개로 잘려 통과한다.
- 300자 라벨은 120자로 잘린다.
- 정의되지 않은 `kind`는 그 블록만 빠지고 나머지는 남는다.
- 남는 블록이 없으면 거절한다.
- 점이 하나뿐인 `series`는 거절한다(차트로 그릴 수 없다).
