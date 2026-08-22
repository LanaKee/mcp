# DB 변경: 인구 측정 의미

Migration: `011_population_measurement_semantics.sql`

`population_observation`에 다음 열을 추가했다.

- `measurement_basis`: 주민등록 snapshot, 과세연도 보고 인구, 연간 통계 인구,
  demo 연간 인구를 구분
- `reference_date_precision`: `day`, `month`, `year`
- `metadata`: 원 period label, canonical period-end 역할, 집계 grain 등

기존 공식 행은 `resident_registration_snapshot`/`month`, 기존 demo 행은
`demo_annual_population`/`year`로 backfill한다. 새 적재기는 세 열을 모두 명시하고
기존 `(region_id, reference_date, source_id)` upsert key를 유지한다.
