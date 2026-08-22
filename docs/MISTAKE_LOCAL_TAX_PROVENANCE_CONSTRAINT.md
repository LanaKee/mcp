# 실수: 지방세 provenance 제약의 demo 값 누락

Migration 008에 headline provenance CHECK를 추가할 때 공식 값과
`legacy_unspecified`만 허용해 이미 적재된 demo의 `demo_settlement`,
`demo_sample`, `demo_declared_krw`를 누락했다. 실제 schema 재적용이 PostgreSQL
`23514`로 실패하면서 발견됐다.

Migration transaction이 rollback되어 fact 변경은 없었다. schema와 migration의
allowlist에 명시적 demo 값을 추가하고 다시 적용했다. 이후 full load와 integration
test로 공식 우선 ranking과 demo 보존을 함께 확인한다.
