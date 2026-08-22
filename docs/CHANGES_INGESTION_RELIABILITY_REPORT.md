# Ingestion Reliability 실측 및 발표 자료

## 포지셔닝

이 구현은 LLM autonomous crawler가 아니라 **deterministic ingestion agent /
self-validating data pipeline**이다. 공공데이터 입력 단계에서는 창의성보다 재현성,
감사 가능성, 실패 격리, 멱등성이 중요하므로 다음 문장으로 정의한다.

> 공공데이터의 수집·검증·정규화·버전 관리·출처 추적부터 AI의 질의와 근거 제시까지
> 하나의 신뢰 체인으로 연결합니다.

기술적으로는 **Raw Public Data → Verifiable AI Answer의 전체 lifecycle을 관리하는
deterministic data infrastructure**다.

## 실험 조건

- stress, idempotency, lineage마다 새 빈 PostgreSQL database 사용
- raw store, inbox, workspace, generated artifact도 모두 임시 경로로 격리
- 측정 뒤 database와 파일 삭제
- 운영 DB와 기본 `datasets/` 수정 없음
- 전체 실험 시간 6.55초

## Ingestion Reliability Stress Test

| 시나리오 | 기대 | 실측 |
| --- | --- | --- |
| 정상 UTF-8 CSV | ingest | 성공 |
| 같은 내용 + 다른 파일명 | duplicate | 성공 |
| 같은 이름 + 다른 내용 | revision | 성공 |
| `.csv` 위장 HTML | quarantine | 성공 |
| 빈 CSV | quarantine | 성공 |
| CP949 CSV | ingest + 인코딩 감지 | 성공 |
| 미등록 지역명 | raw 보존, fact 전환 방지 | fact 0건 |
| 동일 파일 재처리 | DB fact 중복 방지 | 증가 0건 |

발표 숫자:

| 지표 | 결과 |
| --- | ---: |
| 올바르게 처리 | **8/8** |
| 유효 입력 처리 | **2/2** |
| duplicate 탐지 | **1/1** |
| revision 보존 | **1/1** |
| invalid quarantine | **2/2** |
| unsafe normalization | **0건** |
| duplicate facts | **0건** |
| silent overwrite | **0건** |
| data loss | **0건** |
| whole-pipeline failure | **No** |

첫 혼합 배치에서는 accepted 3, duplicate 1, quarantined 2였다. accepted 3건 중 정상
UTF-8과 CP949는 fact로 전환됐고, 미등록 지역은 원본/catalog만 보존되어 valid 2/2와
unsafe normalization 0을 동시에 만족했다. 깨진 파일 2건이 섞여도 유효 입력 처리는
중단되지 않았다.

## 5회 재실행 멱등성

| Run | 판정 | raw store | data_source | facts | locators | ledger events |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| #1 | accepted | 1 | 1 | 1 | 1 | 1 |
| #2 | duplicate | 1 | 1 | 1 | 1 | 2 |
| #3 | duplicate | 1 | 1 | 1 | 1 | 3 |
| #4 | duplicate | 1 | 1 | 1 | 1 | 4 |
| #5 | duplicate | 1 | 1 | 1 | 1 | 5 |

**동일 입력을 5회 처리해도 fact/source/locator 증가 0건**이었다. duplicate 이벤트는
감사 원장에 남아야 하므로 `raw_intake_file`만 1→5로 증가한다. 이는 중복 fact가 아니라
중복 입력을 감지했다는 운영 기록이다.

## End-to-End Provenance Trace

실제 원본 `경상북도 김천시_지방세징수현황_20260529.csv`를 빈 DB에 intake한 뒤 다음
답을 역추적했다.

> 김천시 2024 지방세 수납액은 107,720,311,000원입니다.

```text
107,720,311,000원
  → local_tax_revenue fact (source row 9)
  → data_source UUID
  → source_locator (raw file #row=9)
  → raw_intake_file
  → dataset-intake ingestion_run
  → gyeongbuk-normalized-loader ingestion_run
  → 원본 SHA-256 4e133ad8...a80b8ca
```

값 일치와 6개 lineage node를 모두 확인해 **전체 chain 완성 Yes**를 기록했다.
source URL은 이 로컬 원본에 등록되어 있지 않아 `null`이며, 파일 경로와 SHA-256이
검증 식별자 역할을 한다.

## 발표 Slide 1 — 입력 신뢰성

**제목: 공공데이터를 AI에 넣기 전에 신뢰성을 보장합니다**

```text
RAW PUBLIC DATA
       ↓
Deterministic Ingestion
  ✓ Format validation
  ✓ SHA-256 deduplication
  ✓ Revision control
  ✓ Quarantine
  ✓ Normalization
  ✓ Transactional upsert
       ↓
TRUSTED DATA → MCP
```

우측 숫자:

```text
8 scenarios                 8/8 correctly handled
Invalid accepted            0
Duplicate facts             0
Silent overwrite            0
5 repeated runs             core row delta 0
```

## 발표 Slide 2 — End-to-End Trust

| 질문 | 증거 | 핵심 결과 |
| --- | --- | --- |
| LLM 자체로 충분한가? | Vanilla vs Data Layer, 22문항 | 정확도 36.4→81.8%, 환각 63.6→11.8% |
| 그냥 문서 RAG면 충분한가? | Raw Retrieval vs Structured Layer, v1 10문항 | 정확도 60→80%, 답변 범위 40→80%, 출처 0→50~59.1% |
| 데이터가 바뀌어도 관리 가능한가? | Ingestion Reliability, 8시나리오 + 5회 반복 | 8/8, duplicate fact 0, lineage complete |

하단 메시지:

> 구조화된 데이터 계층은 Raw Retrieval 대비 2배 많은 질문에 답하면서 정확도를
> 20%p 높였고, 답변 기준 환각률을 25%로 유지했으며, 실제 source까지 검증 가능한
> provenance를 제공했습니다.

기존 22문항 `gpt-5.6-luna` 결과의 출처 검증은 0→65.9%, 부재 인지는 0→100%다.
Raw Retrieval v1의 Structured Layer 부재 인지 66.7%는 질문 적합성 분석 대상이며,
정제한 v2에서는 100%였다. v1과 post-hoc v2는 발표에서 반드시 구분한다.

## 산출물과 재실행

- `benchmark/reports/intake-reliability/report.json`
- `benchmark/reports/intake-reliability/report.md`
- `pnpm experiment:intake-reliability`
