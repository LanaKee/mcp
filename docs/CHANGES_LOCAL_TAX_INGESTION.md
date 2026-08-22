# 공식 지방세 ingestion 변경

## 구현

- `datasets/new/` 18개 CSV를 기존 재귀/NFC catalog에 포함했다.
- UTF-8 BOM/CP949를 해석하고 filename이 아닌 header로 징수, 납부매체, 과세,
  1인당 부담, 납세자, 비과세·감면, 미환급, 영치, 검증대기, 재산 microdata를 판별한다.
- 자치단체코드를 canonical 경북 지역과 대조하며 code/name 불일치는 격리한다.
- `(천원)`/`(원)` header를 KRW 정수로 변환한다. 김천 무표기 납부액은 명시적 천원
  징수액과 6개 세목 exact match가 확인된 경우에만 1,000배 변환한다.
- 예천 두 자리 연도는 `20YY`로 확장한 뒤 2000~실행연도+1 범위를 다시 검증한다.
- 합계/총계/소계/계를 표시하고 detail 합계와 검증해 중복 집계를 막는다.
- headline `local_tax_revenue`는 수납액, reported 지방세 총액, 납부액 순으로 선택하고
  amount semantics/source grain/unit provenance를 보존한다.
- PostgreSQL와 메모리 repository는 같은 지역·연도·세목의 공식 행을 sample보다
  우선한다. tool point와 비교 결과는 상태와 source grain을 명시한다.

## 품질·개인정보 결정

- 영천 비과세·감면 720행은 금액/건수 규모가 의심스러워 값을 swap하지 않고 격리했다.
- 김천 일반건축물 40,694 data row는 주소 단위 microdata라 catalog-only governance로
  남기고 fact/search/embedding/tool 응답에서 제외했다.
- 문경 번호판 영치의 장소 문자열은 버리고 기관·날짜·건수·금액만 저장했다.
- blank 수치는 0으로 대체하지 않는다. 선택 measure는 NULL, 전부 blank인 과세행은
  quarantine한다.
- deterministic quality report는 단위/연도/지역/음수·zero-only/징수율/중복/
  aggregate reconciliation/부분 blank/격리 결정을 기록한다.

## 실제 결과

- catalog 440개: PDF 401, XLSX 1, CSV 38
- 공식 headline 368행, 5개 지역, 29개 지역-연도; demo 12행 유지
- 세부 fact: 징수 220, 납부매체 1,131, 과세 57, 1인당 부담 15, 납세자 378,
  비과세·감면 96, 미환급 64, 영치 90
- 품질 issue 85건(info 28, warning 57), severe error 0건
- info: integer 징수율 rounding/truncation 차이 24, 단위 reconciliation/개인정보
  제외/영치장소 제외/trailing empty 각 1
- warning: zero-only 31, 부분 과세 measure 22, 부분 징수 measure 2,
  전체 blank 과세 1, 영천 열 의미 검증대기 1
- 재적재 insert 0건으로 idempotency 확인
- 기존 current PDF chunk/embedding 23,795, page 11,712, 공식 인구 221,
  공식 의회 46,596 유지
- DB-backed smoke: 김천 공식 합계 107,720,311,000원 371.4ms, PDF 의회 검색 3건
  476.7ms; 두 호출의 audit correlation/result count 확인

공식 headline coverage는 경산·구미·김천·봉화·청도에 한정된다. 다른 지역·연도는
sample-only 표시 또는 무결과이며 광역 전체 공식 coverage로 해석하면 안 된다.
