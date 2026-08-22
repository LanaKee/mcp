# Intake Reliability 10종 검증 확장

## 변경 목적

기존 ingestion reliability 실험의 8개 시나리오에 데이터 구조 결함 2종을 추가해
자동처리 파이프라인의 입력 검증 범위를 10종으로 확장한다.

## 검증 데이터

| 번호 | 입력 유형 | 기대 결과 |
| ---: | --- | --- |
| 1 | 정상 UTF-8 CSV | ingest |
| 2 | 같은 내용, 다른 파일명 | duplicate |
| 3 | 같은 이름, 다른 내용 | revision 보존 |
| 4 | CSV로 위장한 HTML | quarantine |
| 5 | 빈 CSV | quarantine |
| 6 | CP949 CSV | 인코딩 감지 후 ingest |
| 7 | 미등록 지역 CSV | raw 보존, fact 전환 방지 |
| 8 | 동일 파일 재처리 | duplicate fact 0건 |
| 9 | 헤더만 있고 데이터 행이 없는 CSV | quarantine |
| 10 | 파싱 불가능한 JSON | quarantine |

모든 fixture는 실행 시 임시 디렉터리에 생성한다. 실험마다 빈 임시 PostgreSQL을
사용하고 종료 후 database와 fixture를 삭제하므로 운영 DB와 기본 dataset store는
변경하지 않는다.

## 판정 변경

- 전체 시나리오: 8개에서 10개
- invalid quarantine 기대값: 2/2에서 4/4
- 혼합 배치에 손상 입력 4개가 있어도 정상 입력의 적재가 완료되는지 확인
- 기존 revision, deduplication, unsafe normalization, idempotency 판정은 유지

## 실측 결과

- 측정 시각: 2026-08-23 08:55 KST
- 전체 실행 시간: 6.82초
- 10개 시나리오 올바르게 처리: **10/10**
- 정상 UTF-8/CP949 ingest: **2/2**
- invalid quarantine: **4/4**
- duplicate 탐지와 revision 보존: 각각 **1/1**
- 미등록 지역 fact, duplicate fact, silent overwrite, data loss: 모두 **0건**
- 손상 입력 4개가 포함된 혼합 batch의 whole-pipeline failure: **No**
- 동일 입력 5회 처리 후 fact/source/locator 증가: 모두 **0건**
- 운영 DB와 기본 dataset store 수정: **없음**

원시 판정과 실행별 row count는
`benchmark/reports/intake-reliability/report.json`, 발표용 표는 같은 디렉터리의
`report.md`에 저장한다.
