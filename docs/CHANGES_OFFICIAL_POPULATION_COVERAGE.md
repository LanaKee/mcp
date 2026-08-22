# 공식 인구 coverage 확장

## 변경

- 구미 2023~2025, 청도 2020~2022의 1인당 지방세 부담 원천에 명시된 `인구수`를
  공식 인구 fact로 적재했다. 경산은 인구 열이 없어 세액/1인당 금액으로 역산하지
  않았다.
- 경상북도 인구 XLSX의 `1-2. 시군별 인구 및 세대현황`을 검증했다. 시군 행이
  아니라 경상북도 전체 연도별 통계이며, 완전한 연간 행 2015~2025를
  `annual_statistical_population`으로 적재했다.
- 행정구역현황 22개 시·군 행과 구미·울진·영덕·포항의 하위 행정구역 snapshot을
  합산해 원문의 정확한 기준일로 적재했다.

## 측정 의미

- `tax_year_reported_population`: 과세연도 보고서에 명시된 인구. 저장 날짜의
  `12-31`은 연도 period key이며 관측일 주장이 아니다.
- `resident_registration_snapshot`: 일/월 기준 주민등록 snapshot.
- `annual_statistical_population`: 연도 단위 도 전체 통계.
- `demo_annual_population`: 기능 시연용 값.

날짜 정밀도(`day`/`month`/`year`)도 별도로 저장한다. 상태가 같더라도 측정기준이나
정밀도가 다르면 하나의 증감률로 합치지 않는다.

## coverage 결과

- 공식 인구: 221행 → 264행
- 공식 인구×공식 headline 지방세 중첩: 1개 지역-연도/1개 지역 →
  8개 지역-연도/4개 지역
  - 경산 2025
  - 구미 2023~2025
  - 청도 2020~2022
  - 포항 2024
- 비교 가능한 신규 공식 인구 시계열:
  - 청도 `tax_year_reported_population` 2020~2022
  - 구미 `tax_year_reported_population` 2023~2025

다른 시·군의 2025 day snapshot과 2026 month snapshot은 raw multi-year coverage지만
정밀도가 달라 하나의 headline 추세로 요약하지 않는다. 도 전체 연간 인구는 시·군세
headline과 범위가 다르므로 교차 비교하지 않는다.

기존 대표 기간 2022~2024는 청도 2024 인구와 구미 2022 인구가 없어 여전히 endpoint를
충족하지 않는다. 기간을 조용히 넓히지 않고, 공식 자료가 실제로 겹치는 2020~2022로
대표 질문을 명시적으로 변경했다. 이 기간에는 청도 인구 감소와 지방세 증가가 모두
공식 동질 series로 확인된다.
