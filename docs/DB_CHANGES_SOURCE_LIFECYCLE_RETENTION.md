# DB 변경: source lifecycle/retention

Migration: `007_source_lifecycle_retention.sql`

## 추가 테이블

- `pdf_processing_version`: extractor/chunker 승인 상태와 activation/retirement 정보
- `pdf_processing_version_event`: seed/approve/rollback/retire 이력
- `document_processing_version`: 문서별 versioned extraction 상태
- `storage_maintenance_run`: purge/ANALYZE/VACUUM plan·상태·결과
- `mcp_tool_audit_daily`: 만료 audit의 비식별 일별 aggregate

## 추가 컬럼

- `document_chunk.processing_version_key`
- `document_chunk.approved_current`
- `document_chunk.created_at`, `document_chunk.stale_at`
- `document_page.created_at`, `document_page.stale_at`
- `source_locator.created_at`

## 인덱스와 제약

- partial unique index로 approved processing version 하나만 허용
- FTS/trigram index를 `is_current AND approved_current` predicate로 재구성
- lifecycle 상태/event, stale chunk/page/document version, audit expiry,
  maintenance token용 index 추가
- existing current output은 approved로 seed하고 다른 retained output은 retired로 분류

## 삭제/rollback 정책

- stale purge 순서: chunk locator → embedding → chunk, page locator → page,
  document processing version, orphan locator
- approved/current/candidate rows와 아직 fact/provenance가 참조하는 base source/document는
  삭제하지 않는다.
- 승인 전 retained chunk/document/embedding coverage를 확인한다.
- rollback은 retained embedding을 재사용하며 broad delete/recompute를 하지 않는다.
- purge transaction에서 VACUUM을 실행하지 않는다.

Migration은 idempotent하다. 기존 검색 index predicate를 검사하고 필요할 때만 rebuild하며
index rebuild 중 parallel maintenance를 사용하지 않아 shared-memory 위험을 낮춘다.
이미 올바른 current/stale/approval 값은 다시 UPDATE하지 않아 반복 적용의 MVCC churn도
피한다.
