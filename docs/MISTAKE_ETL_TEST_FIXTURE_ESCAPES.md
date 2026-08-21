# MISTAKE — ETL Test Fixture Escapes

날짜: 2026-08-22

초기 CSV 단위 테스트 문자열에 줄바꿈 `\n` 대신 문자 그대로의 `\\n`이 들어가
csv-parse가 데이터 행을 만들지 못했다. 실제 ETL dry run은 정상 동작했지만 테스트
fixture가 잘못되어 두 테스트가 실패했다.

fixture를 실제 줄바꿈으로 수정하고 전체 테스트를 다시 실행해 회귀를 확인했다.
향후 CSV fixture는 파싱 결과의 header/row 수까지 함께 검증한다.

