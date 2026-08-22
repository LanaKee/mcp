# 포항시의회 의안 데이터셋 수집·정제

## 목적

[포항시의회 의안검색](https://council.pohang.go.kr/content/activity/billSearch.html)의 전체 목록과 상세 처리 이력을 재현 가능한 방식으로 수집해 기존 의안 ETL과 호환되는 CSV 및 손실 없는 상세 JSON으로 정제한다.

## 산출물

`datasets/pohang-council/` 아래에 다음 로컬 데이터셋을 생성한다. 저장소 정책상 `datasets/`는 Git에서 제외된다.

- `경상북도_포항시_의회_의안정보.csv`: UTF-8 BOM CSV. 기존 `council_agenda` 감지 및 정규화 로직에 바로 입력할 수 있다.
- `pohang_council_bills.json`: 목록, 위원회·본회의 처리 이력, 첨부파일 메타데이터, 원문 URL, 필드별 품질 이력을 보존한다.
- `pohang_council_bills.metadata.json`: 수집 시각, robots 상태, 요청 정책, 레코드·첨부·품질 이슈 수, 날짜 범위, 각 산출물 SHA-256을 기록한다.

2026-08-22 수집본은 사이트 표시값과 같은 3,112건이며, 내부 원문 레코드 ID와 상세 URL도 각각 3,112개로 중복이 없다. 첨부파일 메타데이터는 2,326건이다. 첨부 바이너리는 복제하지 않고 공식 다운로드 URL과 사이트 내부 첨부 ID만 보존했다.

## 수집 필드

- 기본: 원문 레코드 ID, 의안번호, 의안명, 발의자, 공유된 의원, 회기, 접수일, 발의일, 이송일
- 위원회: 소관위원회, 회부일, 상정일, 처리일, 결과
- 본회의: 상정일, 처리일, 결과
- 첨부: 파일명, 다운로드 URL, 원문 첨부 ID
- 출처: 의안 상세 URL, 지역명, 의회명
- 품질: 원문 날짜 값, 정규화 값, 필드, 품질 이슈 코드

## 실행 방법

공개 사이트의 이용 조건과 크롤링 정책을 검토한 운영자가 다음 명령을 실행한다. `robots.txt`가 HTML 오류 페이지 등으로 해석 불가능한 경우에만 두 번째 승인 플래그를 사용한다.

```bash
pnpm --filter @gb/pipelines exec tsx src/pohang-council-cli.ts \
  --output ../datasets/pohang-council \
  --concurrency 2 \
  --delay-ms 500 \
  --acknowledge-terms \
  --acknowledge-robots-unavailable
```

동시성은 1~4, 전체 요청 시작 간격은 최소 250ms로 제한한다. 모든 요청에 식별 가능한 전용 User-Agent를 사용하고, 일시 오류에는 지수 백오프 재시도를 적용한다.

## 정제 및 품질 규칙

- HTML 엔티티를 해제하고 Unicode NFC 및 공백을 정규화한다.
- 목록의 공시 총건수와 모든 페이지에서 찾은 고유 원문 ID 수가 다르면 산출물을 쓰지 않는다.
- 필수 상세 필드인 의안명과 의안번호가 없으면 수집을 실패시킨다.
- 날짜는 실제 달력 날짜이며 1990년부터 수집 연도의 다음 연도 사이일 때만 사용한다.
- 원문의 `02xx-MM-DD` 연도 전치 11건은 `20xx-MM-DD`로 보정하고 원문과 `source_year_transposition` 이력을 남긴다.
- 점 구분 날짜 1건은 ISO 날짜로 바꾸고 `source_date_delimiter_normalized` 이력을 남긴다.
- `0000-00-00` 1,479건은 결측 센티널로 처리하고 `missing_date_sentinel`로 구분한다.
- 안전하게 해석할 수 없는 날짜 3건은 `null`로 격리하고 `invalid_source_date`로 보존한다.
- CSV 셀은 RFC 4180 방식으로 인용하며 JSON 품질 이력도 `데이터품질이슈` 열에 포함한다.
- 결과 파일은 임시 파일에 완성한 뒤 rename하며, 중간 실패 결과를 완성본 경로에 쓰지 않는다.

## 데이터베이스 연결

CSV 파일명과 헤더는 기존 포항시 지역 추론 및 `council_agenda` 어댑터와 호환된다. 로드 계획에서 provider는 `포항시의회`, source URL은 공식 의안검색 페이지로 기록되어 PostgreSQL의 `council_record`와 `data_source`에 출처가 유지된다.

원문 레코드 ID로 결정적 `council_record_id`를 생성하므로 정규화 CSV의 열이나
직렬화가 바뀌어도 같은 의안 ID가 유지된다. 이전 SHA/행 기반 ID는 새 load plan에
동일 원문 레코드가 있을 때만 트랜잭션 안에서 교체하며, 새 실행에 없는 의안을
삭제하지 않는다.

## 검증

- 목록·상세 HTML 파서 단위 테스트
- 위원회와 본회의의 동명 필드 분리 테스트
- HTML 엔티티, CSV 인용, 날짜 보정·결측·오류 격리 테스트
- robots 허용·금지 규칙 및 운영자 승인 게이트 테스트
- 2페이지 모의 전체 수집, 전역 요청 간격, 원자적 파일 출력, SHA-256 메타데이터 테스트
- 생성 JSON·CSV·메타데이터 레코드 수 일치 및 원문 ID·URL 고유성 검사
- 기존 ETL의 `council_agenda` 감지와 3,112행 정규화 확인
- PostgreSQL 공식 포항 의안 3,112건, `source_year_transposition` metadata 11건
- 같은 load plan 재적재 뒤에도 위 건수 유지
