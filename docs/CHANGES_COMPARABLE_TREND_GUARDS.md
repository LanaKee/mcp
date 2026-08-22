# 비교 가능한 시계열 파생 통계 guard

## API 변경

- 인구/지방세 trend는 `summary`, `summary_unavailable_reason`,
  `series_segments`를 반환한다.
- `summary`는 두 점 이상이며 전체 point의 비교 key가 같을 때만 존재한다.
- 지방세 비교 key: `dataStatus`, `accountingBasis`, `amountSemantics`,
  `sourceGrain`, `unitOriginal`, `unitMultiplier`
- 인구 비교 key: `dataStatus`
- 혼합 series는 원 point를 삭제하지 않고 segment별로 분리해 반환한다.
- 시작값이 0이면 절대 변화와 방향만 반환하고 증감률은 `null`
  (`zero_baseline`)이다.

`compare_population_and_tax`는 지역별 `evaluable`, `notEvaluableReason`,
nullable `populationTrend`/`taxTrend`/`matches`와 source/status/segment를 반환한다.
`matches`에는 비교 가능한 공식 series만 포함되고 나머지는 `not_evaluable`에 들어간다.
비교 응답의 demo segment는 raw point context만 유지하고 segment summary도 생성하지 않는다.

## 근거 소비

- `verify_claim_with_data`는 demo 기준값을 context로 반환할 수 있지만 verdict는
  `not_verifiable`이고 차이/차이율은 NULL이다.
- `draft_public_document`는 demo 또는 비공식 source를 검증 근거로 거절한다.
- 대표 demo는 공식 비교가 없으면 결론/초안을 생성하지 않고 이유를 보여 준다.
- Web UI evidence는 `official_observed`, `demo_sample`, `incomparable` badge를 표시한다.
- evaluation contract는 derived statistic availability를 검증할 수 있다.

기본 factual listing은 이전처럼 공식+demo를 반환한다. 변경점은 서로 비교할 수 없는
point에서 파생 결론을 만들지 않는 것이다.

최종 token-auth/PostgreSQL HTTP smoke에서 김천 trend는 155.3ms,
`summary: null`/`incomparable_sources`였고 비교는 315.6ms,
matches 0/`taxTrend: null`이었다. 두 audit correlation이 성공으로 기록됐으며
직렬화된 응답 어디에도 `-54.36`은 없었다.
