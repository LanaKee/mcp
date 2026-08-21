# DB CHANGES — Initial Schema

날짜: 2026-08-22

초기 PostgreSQL 스키마를 추가했다.

- 행정구역 차원: `dim_region`
- 출처·수집 실행: `data_source`, `ingestion_run`
- 정량 fact: `population_observation`, `local_tax_revenue`
- 정책·의회: `policy_program`, `council_record`
- 문서 검색·추적: `document`, `document_chunk`, `source_locator`
- 지역/연도, 배열, trigram, full-text, SHA-256 조회 인덱스
- 모든 사실 테이블의 `data_status` 제약

마이그레이션 `db/migrations/001_initial.sql`은 psql의 `\ir`로 기준
`db/schema.sql`을 실행하여 두 정의가 어긋나지 않도록 한다.

