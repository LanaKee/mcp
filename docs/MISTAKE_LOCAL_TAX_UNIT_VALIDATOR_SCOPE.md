# 실수: 단위 validator helper scope

상충 단위 검사를 추가하면서 helper를 `unitFromHeaders` 내부 block에 잘못 삽입해
호출 위치에서 정의되지 않았다. full lint/test/ETL이 TypeScript 오류와
`ReferenceError`로 즉시 실패했다.

helper를 module scope로 이동하고 conflict-unit unit test, full ETL과 전체 validation을
다시 실행했다. 실패한 실행은 artifact/DB를 변경하지 않았다.
