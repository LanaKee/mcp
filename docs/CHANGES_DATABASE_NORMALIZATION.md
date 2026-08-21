# PostgreSQL 정규화 적재 구현

## 변경 내용

- 경상북도와 군위군 전출 이후 현재 22개 시·군의 canonical 코드/alias를 추가했다.
- 포항 인구 CSV의 `년월`을 연도만 저장하지 않고 정확한 날짜로 유지한다.
- XLSX 제목의 `2026년 7월`을 `2026-07-31`로 해석하고 경북/시군 집계 열만 읽는다.
- 422개 공식 원천을 경로+SHA-256 source version으로 만들고 PDF는 `catalog_only`로 적재한다.
- 공식 인구 221건, 의회 46,596건과 데모 인구·지방세·정책·의회 전체를 load plan으로 만든다.
- 의회 ID는 source SHA/경로/행/의안번호 hash로 결정하고 인구·의회 locator를 생성한다.
- `db:schema`, `db:load`, `db:normalize` 명령과 `--official-only`, `--skip-schema`를 추가했다.
- 500행 parameterized upsert, fact transaction, ingestion 성공/부분/실패 기록을 구현했다.

## 안정성

- 새 실행에서 사라진 기존 행은 삭제하지 않는다.
- 미해결 지역이나 잘못된 factual row는 임의 지역 ID 대신 reject/error count로 남긴다.
- `.env`의 `DATABASE_URL`은 읽기만 하며 로그에 출력하지 않는다.
