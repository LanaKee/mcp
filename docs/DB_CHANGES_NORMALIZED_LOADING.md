# 정규화 적재 스키마 변경

## 마이그레이션

`db/migrations/002_normalized_loading.sql`을 추가했다.

- `policy_program.ingestion_run_id` 추가
- `council_record.ingestion_run_id` 추가
- 두 실행 FK의 조회 인덱스 추가

`db/schema.sql`도 새 설치 시 같은 구조가 생성되도록 정렬했다. 기존 migration history는
수정하지 않았으며 `pnpm db:schema`은 현재 schema와 002 migration을 idempotent하게
적용한다.

## 적재 자연키

- 출처: `source_key = status namespace + relative path/logical ID + SHA-256`
- 인구: `(region_id, reference_date, source_id)`
- 지방세: `(region_id, fiscal_year, tax_category, accounting_basis, source_id)`
- 정책: `policy_id`
- 의회: 원천 버전과 행 위치로 만든 deterministic `council_record_id`
- locator: `(source_id, entity_type, entity_key)`

따라서 같은 입력 재실행은 update가 되고, 원천 파일 hash가 바뀌면 별도 source version과
공식 의회 레코드가 추가된다.
