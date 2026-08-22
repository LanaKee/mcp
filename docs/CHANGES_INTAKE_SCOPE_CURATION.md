# CHANGES: intake 대상 선별 (경북 범위 밖 원천 격리)

## 배경

`data/intake/inbox/`에 130개 항목이 쌓여 있었다. 이 프로젝트의 명시된 범위는
`README.md`가 말하는 "경상북도와 시·군의 인구·지방세·정책·의회 데이터"이고,
`dim_region`에는 경상북도(47)와 그 22개 시·군만 존재한다. inbox 전체를 훑어
본 결과 이 범위와 맞는 항목은 다음 1건뿐이었다.

- `경상북도 김천시_무인민원발급기 현황_20260311.csv` — 경북 김천시의 무인민원
  발급기 위치·운영시간 데이터. `시도/시군구` 컬럼이 실제로 `경상북도/김천시`.

나머지 129개는 다음 범주였고, 모두 이 프로젝트의 인구·지방세·정책·의회
범위 밖이다.

- 국세청(NTS) 전국 단위 세무 통계 xlsx 약 40종(세수, 체납, 환급, 이의신청,
  국세상담센터 등 번호가 매겨진 시리즈)과 관련 hwpx(국세통계, 국세및지방세
  납부현황 등). `localTaxYearbookFiscalYear()` 감지기로 실제 내용을 확인한
  결과 이들 hwpx는 행정안전부 지방세통계연감 내부 marker와 일치하지 않아
  `contentKind: "other"`로만 분류되고 fact를 만들지 못한다.
- 한국재정정보원·재정경제부·기획예산처의 국가 재정통계 CSV 약 30종(세입,
  세출, 회계·기금, 국세수입 추이 등).
- 한국건강증진개발원의 전국 주류(주세) 출고·조세 통계 CSV 6종.
- 한국자산관리공사·한국남부발전·한국수력원자력의 세금 납부 관련 CSV.
- 대구·부산·대전 등 경북 외 지역의 지방세/마을세무사 CSV 4종 — 같은 "지방세"
  주제이지만 `dim_region`에 없는 지역이라 지역 매칭이 실패한다.
- 전국 단위 공시지가/기준시가 조사산정 지침 및 오피스텔 기준시가 고시 PDF.
- 국세청 홍보 동영상(mp4) 5개, 썸네일 jpg, 2019년도 전국 고등교육기관 졸업자
  취업통계연보, 도로명주소 전자지도 pptx 등 데이터가 아니거나 범위 밖인 첨부.
- 손상/미완성 다운로드(`cfdown.do.txt`, 빈 `.download` 디렉터리) 및 확장자가
  실제 내용과 다른 `.pdf.docx` 파일.

## 조치

1. 위 129개 항목을 `data/intake/inbox/`에서
   `data/intake/excluded/2026-08-22-out-of-scope/`로 이동했다(삭제하지 않음).
   추후 프로젝트 범위가 국세/전국 재정 통계로 확장되면 재검토할 수 있도록
   보존한다.
2. 남은 `경상북도 김천시_무인민원발급기 현황_20260311.csv` 1건만
   `pnpm intake`로 정식 적재했다. `raw_intake_file`에 `accepted`로 기록되고
   `datasets/misc/`에 저장, `data_source`에 `official_observed`로 카탈로그됐다
   (`source_id 703b6488-d63b-4887-8cac-c070c7f45b1d`).
3. 선별 과정에서 발견한 intake 파이프라인의 OOM 버그는 별도로
   `docs/MISTAKE_INTAKE_LARGE_FILE_OOM.md`에 정리하고 수정했다.

## 검증

- `pnpm intake:dry-run` (curation 전): 국세청 mp4/xlsx가 섞인 상태에서 OOM으로
  실패 → 파이프라인 수정 후 재현 확인 및 수정.
- `pnpm intake:dry-run` (curation 후, 파일 1개): `accepted: 1, quarantined: 0`.
- `pnpm intake` 실제 실행: `raw_intake_file`, `data_source`에 반영 확인,
  `pnpm intake:status`로 ledger 확인.
- `data/intake/inbox/`가 비었음을 확인.
