# 행정안전부 지방세통계연감 coverage

## 원천과 범위

- 공공데이터포털 `행정안전부_지방세통계연감_20241231`
- 실제 첨부: `2025 지방세통계연감.hwpx`
- 회계연도: HWPX 내부 목차/장 marker에서 판별한 2024년
- 이용허락범위: 제한 없음
- SHA-256:
  `0fc7693fbbc145190b9cd09a8ddd5922892eedcaf0aa8f824ce6bf23f2617c25`

파일명에 의존하지 않고 ZIP/HWPX 내부의 `제4장 2024년도 시·도, 시·군·구별
부과·징수실적`, `1-16. 경상북도`, 시세/군세 표와 `단위: 천원` marker를 검사한다.

## 정규화

- 현재 22개 시·군 모두의 시세/군세 소계와 세목을 KRW 정수로 변환했다.
- `source_grain=statistical_yearbook_local_collection`
- 연감 176행, 지역 소계 22행, source locator 176개/원본 지역 행 22개
- `전체 징수액 - 도세 = 시·군세 소계` 22건 통과
- `시·군세 소계 = 세목 합계` 22건 통과
- 김천 municipal CSV와 시세 소계 107,720,311,000원 exact match

청도·봉화의 municipal CSV 합계는 연감의 전체 징수액과 일치해 도세+군세 결합
범위임을 확인했다. 이 두 원본 fact는 삭제하지 않고
`metadata.headlineEligible=false`로 보존하며, 도구는 비교 가능한 연감 군세 소계를
선택한다.

## 결과

- 공식 headline: 544행
- 공식 합계 coverage: 22개 시·군, 46개 지역-연도
- 품질 issue: info 31, warning 57, error 0
- 동일 artifact 재적재: insert 0, 최종 공식 headline 544 유지
- PostgreSQL 포항 2024 API: 440,369,434,000원, 239.0ms, audit 성공
- 기존 current chunk/embedding 23,795, page locator 11,712, 공식 인구 221,
  공식 의회 46,596 유지

2024만 존재하는 지역은 한 점뿐이므로 증감률을 반환하지 않는다. 다음 작업은 동일
시·군세 scope의 과거 연도 확보와 연감 간 schema drift 평가다.
