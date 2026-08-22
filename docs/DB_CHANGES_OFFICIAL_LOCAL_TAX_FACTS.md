# DB 변경: 공식 지방세 fact

Migration: `008_official_local_tax_facts.sql`

## `local_tax_revenue` 확장

- `accounting_basis`에 `reported` 추가
- `amount_semantics`, `source_grain`
- `unit_original`, `unit_multiplier`, `unit_provenance`
- `is_aggregate`, `source_row`, `metadata`
- 공식 우선 repository 조회용 지역/연도/세목/status/grain index

기존 demo 행은 `demo_settlement`, `demo_sample`, `demo_declared_krw`로 명시하고,
migration 전 legacy 행의 안전한 기본값은 `legacy_unspecified`로 보존한다.

## 추가 테이블

- `local_tax_collection_status`
- `local_tax_payment_media`
- `local_tax_assessment_status`
- `local_tax_per_capita_burden`
- `local_tax_taxpayer_status`
- `local_tax_exemption_status`
- `local_tax_unrefunded_status`
- `local_tax_enforcement_statistic`
- `data_quality_issue`

각 fact는 canonical region, source UUID, source row, ingestion run,
`official_observed` 상태와 자연 grain index를 가진다. source version/row unique key로
idempotent upsert한다. 원천에서 선택적으로 비어 있는 징수 부가금액과 과세/비과세
measure는 NULL을 허용해 missing을 zero로 바꾸지 않는다.

## 적재·보존

- 모든 값은 parameterized 500-row batch upsert다.
- source locator는 각 공식 지방세 fact와 headline 원본 row를 연결한다.
- 품질 issue key는 source SHA/path/row/code/field에서 결정적으로 생성한다.
- 영천 검증대기와 김천 property microdata에는 fact locator가 없다.
- migration은 idempotent하며 기존 population/council/document/PDF lifecycle 행을
  삭제하거나 current visibility를 변경하지 않는다.

실제 적재 후 공식 headline 368행, 세부 fact 2,051행, quality issue 85행이며,
같은 artifact 재적재는 insert 0행이었다.
