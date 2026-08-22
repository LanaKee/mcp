# Source lifecycle/retention 변경

## 구현

- PDF extractor/chunker 조합을 `candidate`, `approved`, `retired`로 관리한다.
- 기존 production version을 migration에서 approved로 seed하고 approved 하나를 DB
  unique index로 강제한다.
- hybrid 검색/source context는 approved/current chunk만 사용한다.
- candidate 적재는 기존 검색을 바꾸지 않는다.
- retained version 승인/rollback은 document/embedding coverage를 확인하고 한 transaction에서
  chunk/page/document 가시성을 전환한다.
- status 명령과 token 전용 `/api/admin/storage`가 current/stale 행, relation/index 크기,
  lifecycle version, 만료 audit와 안전한 PostgreSQL 설정을 보고한다.
- stale/audit purge는 dry-run 기본, exact plan hash, 최소 보존기간, advisory lock,
  bounded batch/max rows/runtime와 재개를 제공한다.
- audit purge는 삭제 전 일별 aggregate를 보존한다.
- maintenance는 allowlist ANALYZE-only가 기본이고 VACUUM은 두 번째 명시 확인이 필요하다.
- migration 재적용은 이미 올바른 current/stale 행을 다시 UPDATE하지 않아 반복 schema
  확인이 MVCC/index bloat를 만들지 않는다.

## 실제 검증

- approved/current chunk와 embedding 각 23,795, current page locator 11,712
- retained stale chunk와 embedding 각 17,487
- 30일 stale dry-run: eligible 0건, 실제 stale corpus 삭제 없음
- controlled retired fixture: 2 chunk, 2 embedding, 2 chunk locator, 1 page,
  1 page locator, 1 document version을 `maxRows=1` partial/resume으로 삭제
- expired audit fixture 2건을 일별 aggregate 후 삭제
- retained 17,487-chunk version rollback 후 23,795-chunk version 복구
- full PDF rerun: 401 documents, 11,712 pages, 23,795 current chunks,
  embedding generated 0/skipped 23,795
- 최종 DB 1,521,482,775 bytes, stale ratio 42.4% 경고
- schema를 두 번 재적용해 sampled current/stale chunk의 `xmin`이 유지됨을 확인
- ANALYZE는 10분 statement bound에서 성공했다. 이전 `53100` VACUUM은 재시도하지 않았다.

## 운영 주의

실제 stale 17,487개는 보존기간 경과와 운영자 승인 전까지 유지한다. dry-run token은
후보 ID/hash, cutoff, 수와 byte 추정에 묶이므로 후보 변경 시 새 plan이 필요하다.
purge는 VACUUM을 자동 실행하지 않으며 물리 공간 회수는 별도 maintenance window다.
