# demo_sample 데이터 제거

## 변경 목적

공식 데이터 적재가 완료된 운영 데이터베이스와 실행 경로에서 기능 시연용 `demo_sample` 데이터를 제거한다. 스키마의 과거 상태 값은 기존 감사 기록과 호환성을 위해 유지하지만, 운영 로드 계획은 데모 행을 만들지 않는다.

## 삭제 범위

삭제 전 운영 DB에서 확인한 데모 데이터는 다음과 같다.

- `data_source`: 4행
- `population_observation`: 12행
- `local_tax_revenue`: 12행
- `policy_program`: 3행
- `council_record`: 5행
- `mcp_tool_audit`: `demo_sample`을 참조한 69행

마이그레이션 `012_remove_demo_data.sql`은 위 사실 테이블과 데모 전용 locator/source를 참조 무결성 순서에 따라 삭제한다. 혹시 존재할 수 있는 데모 문서와 처리 버전도 같은 상태 조건으로 제거한다. 상태별 구분이 없는 비식별 일별 감사 집계는 공식 호출 집계까지 훼손할 수 있어 삭제하지 않는다.

## 재발 방지

- DB CLI는 공식 데이터만 로드하며 데모 포함 옵션을 제공하지 않는다.
- `createLoadPlan`은 공식 ETL 결과만 계획하며 데모 적재 코드 경로를 완전히 삭제했다.
- PostgreSQL 미설정 시 런타임은 샘플 데이터로 자동 대체하지 않는다.
- 명시적 메모리 모드는 빈 저장소로 시작한다.
- 종전 `data/sample/` 파일은 운영 데이터 경로에서 제거했다. 데모 거부·혼합 상태
  안전장치의 회귀 검증에 필요한 합성 값만 `services/mcp-server/test-fixtures/demo/`로
  격리했으며 런타임에서는 읽지 않는다.

## 응답 상태 보정

기본 조회 상태가 `official_observed`만 남으면서 결과가 0건인 응답이 정상적으로
발생한다. 종전 `responseStatus([])`는 이를 `mixed`로 표기해 "여러 상태가 섞였다"는
잘못된 신호를 줬다. 빈 결과는 `empty`로 구분해 반환한다.

## 검증

마이그레이션 후 `data_status = 'demo_sample'`을 지원하는 모든 테이블과 `data_source`, `mcp_tool_audit.data_statuses`를 다시 집계해 0인지 확인한다.
