# 실수: 혼합 상태 지방세의 허위 추세 요약

## 잘못된 결과

PostgreSQL에서 김천시 2020~2024 지방세를 기본 상태 필터로 조회하면 다음 점이 함께
반환됐다.

- 2022: 236,000,000,000원, `demo_sample`, `demo_settlement`
- 2023: 231,000,000,000원, `demo_sample`, `demo_settlement`
- 2024: 107,720,311,000원, `official_observed`, `collected_amount`

기존 구현은 point의 상태와 의미를 표시하면서도 전체 배열을 `summarizeTrend`에 그대로
넘겼다. 그 결과 `-128,279,689,000원`, `-54.36%`, `decrease`를 생성했고
`compare_population_and_tax`도 같은 허위 방향을 사용했다. 표시 label은 이미 생성된
잘못된 파생 결론을 무효화하지 못한다.

## 근본 원인

- trend 함수의 입력 계약에 비교 가능성 조건이 없었다.
- `data_status`, 회계 기준, 금액 의미, source grain, 원단위/배수를 응답 metadata로만
  취급했다.
- 단일 point도 0% 추세로 계산할 수 있었다.
- 비교 도구와 대표 demo가 nullable/not-evaluable 상태를 모델링하지 않았다.
- claim verification과 public drafting이 demo 값을 근거로 사용할 수 있었다.

## 수정

- 파생 통계 전에 상태·회계 기준·금액 의미·grain·단위가 모두 같은지 검사한다.
- 두 점 미만은 `summary: null`, `insufficient_points`다.
- 시작값 0의 증감률은 수학적으로 정의되지 않으므로 `null`,
  `zero_baseline`으로 반환한다.
- 혼합 series는 `summary: null`, `incomparable_sources`이며 homogeneous segment를
  별도로 반환한다. 전체 requested series를 가로지르는 요약은 만들지 않는다.
- 인구/지방세 비교는 정확한 endpoint, 비교 가능한 series, 양쪽 공식 상태가 모두
  충족될 때만 `matches`를 계산한다. 그 외에는 `evaluable: false`, `matches: null`이다.
- demo claim은 `not_verifiable`; demo/비공식 source의 공공문서 drafting은 거절한다.
- 대표 demo/UI는 공식 결론과 demo/비교불가 context를 badge와 설명으로 분리한다.

## 예방

정확한 재현 payload, mixed status, 같은 status의 다른 semantics/basis/grain/unit,
single point, homogeneous official series, comparison not-evaluable, claim/draft guard,
PostgreSQL 김천 회귀를 자동 test로 고정했다. `-54.36`이 두 DB 응답 어디에도 나타나지
않는지 smoke에서 확인한다.
