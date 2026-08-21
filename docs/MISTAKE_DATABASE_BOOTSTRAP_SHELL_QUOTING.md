# 데이터베이스 bootstrap 셸 quoting 실수

## 현상

누락된 개발 DB를 확인하는 일회성 셸 명령에서 PostgreSQL placeholder `$1`이 셸에서 먼저
확장되어 구문 오류가 발생했다. 저장소 코드나 데이터 변경 전 실패했다.

## 수정

placeholder를 셸에서 escape한 뒤 parameterized query로 다시 실행했다. 실제 DB CLI는
셸 조합 SQL을 사용하지 않고 `pg` parameter binding과 고정 명령만 사용한다. 또한 pnpm의
옵션 구분자 `--`가 하위 CLI에 전달되어도 무시하도록 보완했다.

후속 무결성 확인 SQL에서는 두 테이블에 모두 있는 `reference_date`를 처음에 한정하지 않아
ambiguous-column 오류가 났다. `p.reference_date`로 명시해 재실행했으며 적재 데이터에는
영향이 없었다.
