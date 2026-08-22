# Ingestion Reliability Stress Test

- 측정 시각: 2026-08-22T23:55:01.246Z
- 전체 측정 시간: 6.82초
- 환경: 매 실험마다 빈 임시 PostgreSQL과 격리된 raw store 사용 후 삭제

## Stress Test

| 항목 | 결과 |
| --- | ---: |
| 시나리오 | 10 |
| 올바르게 처리 | 10/10 |
| 정상/CP949 ingest | 2/2 |
| 내용 기반 duplicate 탐지 | 1/1 |
| revision 보존 | 1/1 |
| HTML/빈 파일/무행 CSV/손상 JSON quarantine | 4/4 |
| 미등록 지역 fact 전환 | 0건 |
| 동일 입력 재처리 후 duplicate fact | 0건 |
| silent overwrite | 0건 |
| data loss | 0건 |
| 전체 pipeline 실패 | No |

## 5회 재실행 멱등성

| Run | 판정 | raw store | data_source | facts | locators | ledger events |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| #1 | accepted | 1 | 1 | 1 | 1 | 1 |
| #2 | duplicate | 1 | 1 | 1 | 1 | 2 |
| #3 | duplicate | 1 | 1 | 1 | 1 | 3 |
| #4 | duplicate | 1 | 1 | 1 | 1 | 4 |
| #5 | duplicate | 1 | 1 | 1 | 1 | 5 |

- fact 증가: **0건**
- source 증가: **0건**
- locator 증가: **0건**
- 핵심 row count 안정: **Yes**
- duplicate 이벤트는 원장에 남으므로 ledger events만 1→5로 증가한다.

## End-to-End Provenance Trace

> 김천시 2024 지방세 수납액은 107,720,311,000원입니다.

- 관측값: 107,720,311,000원
- fact: `8`
- source: `7be5bee5-9016-4a8e-8b24-43e7494a05a7`
- locator: `df6c9bb4-bd04-40eb-9409-af94589272e0` → `../../../../var/folders/py/qr_fv2t93sd177bjx7l_jx6r0000gp/T/gb-intake-reliability-X539bD/lineage/datasets/local-tax/경상북도 김천시_지방세징수현황_20260529.csv#row=9`
- raw intake: `1`
- intake run: `4674c1dc-097d-4655-a3fc-ad7d1495872a`
- raw file: `../../../../var/folders/py/qr_fv2t93sd177bjx7l_jx6r0000gp/T/gb-intake-reliability-X539bD/lineage/datasets/local-tax/경상북도 김천시_지방세징수현황_20260529.csv`
- SHA-256: `4e133ad8e70adc2afbe760f1ffe86add8ffdb17dd99daa8c385a5c18da80b8ca`
- 전체 chain 완성: **Yes**
