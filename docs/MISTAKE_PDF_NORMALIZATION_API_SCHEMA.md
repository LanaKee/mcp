# PDF 정규화 구현 중 수정한 실수

## PDF.js cleanup API

초기 smoke test에서 document proxy에 없는 `destroy()`를 호출했다. 실제 API는 loading
task의 `destroy()`와 page `cleanup()`이므로 extractor를 그 수명주기에 맞게 수정했다.

## 기존 DB schema 적용 순서

최종 `schema.sql`의 새 index가 기존 테이블에 아직 없는 컬럼을 먼저 참조해 첫 제한 실행이
`schema_outdated`로 실패했다. 기존 테이블이면 002/003 migration을 먼저 적용한 뒤 최종
schema를 실행하고, 새 DB이면 schema를 먼저 만드는 순서로 수정했다.

## 검색 성능

초기 array cosine 구현은 17,487 chunk를 모두 계산해 약 15초가 걸렸다. FTS/trigram
index로 최대 200개 candidate를 materialize하고 그 안에서만 cosine rerank하도록 바꿔
실측 약 0.16~0.20초로 줄였다.
