# 실수: lifecycle migration 재적용의 row churn

## 문제

초기 migration 007은 기존 current/stale 상태를 seed할 때 값이 이미 올바른 chunk/page도
매번 `UPDATE`했다. lifecycle CLI가 기본적으로 schema를 확인하므로 status/dry-run 같은
읽기성 운영 명령도 PostgreSQL MVCC dead tuple과 index churn을 늘릴 수 있었다.

실제 rollback 검증과 반복 schema 적용 뒤 `document_chunk` total relation이
846,340,096 bytes까지 증가해 이 위험을 확인했다. 증가분 전체가 migration 때문이라고
단정할 수는 없고 full visibility 전환도 dead tuple을 만든다.

## 수정

- 승인되지 않은 chunk는 current/approved/stale 값 중 변경이 필요한 경우에만 갱신
- approved current chunk는 `approved_current` 또는 `stale_at`이 잘못된 경우에만 갱신
- stale chunk/page는 `stale_at IS NULL`인 경우에만 timestamp 설정
- index predicate가 이미 lifecycle 조건이면 rebuild하지 않음

## 검증

patched schema를 두 번 재적용하고 sampled current/stale chunk의 `xmin`을 비교해 row
version이 바뀌지 않음을 확인했다. 이미 발생한 물리 bloat는 자동 VACUUM하지 않았으며
shared-memory/disk 점검 뒤 별도 maintenance window에서 처리해야 한다.
