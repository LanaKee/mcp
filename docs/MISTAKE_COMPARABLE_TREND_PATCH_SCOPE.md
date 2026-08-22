# 실수: comparable-trend patch scope

초기 수정 중 helper를 기존 함수 block 안에, PostgreSQL 회귀 `it`을 기존 test 안에
잘못 삽입했다. TypeScript `TS1184`와 Vitest의 nested-test 오류가 각각 즉시 실패해
production build나 commit에는 들어가지 않았다.

두 정의를 module/describe scope로 이동하고 targeted typecheck와 PostgreSQL integration을
재실행했다. 이후 patch는 삽입 위치 주변을 먼저 읽고 적용하며, 함수/test 추가 직후
해당 package validation을 실행한다.
