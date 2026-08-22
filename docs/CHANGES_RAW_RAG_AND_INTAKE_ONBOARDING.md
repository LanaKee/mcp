# Raw RAG 비교 및 신규 데이터 onboarding 실측

## 목적

기존 Vanilla vs MCP 결과가 증명한 효과성과 별도로 다음 두 질문을 실측했다.

1. 같은 원본 공공데이터를 단순 RAG로 연결해도 현재 semantic/정규화 계층과 같은
   결과가 나오는가?
2. 아직 비어 있는 PostgreSQL에 실제 이상 원본을 반입해 catalog와 원장에 저장하는 데
   얼마나 걸리는가?

## Raw Document Retrieval vs Structured Data Layer

### 조건

- 모델: `gpt-4o-mini`, `gpt-5.6-luna` (각 실행 안에서 양 arm 동일)
- 문항: 기존 22문항 중 정밀도 4, 부재 인지 3, 출처 2, 최신성 1의 총 10문항
- 정답/채점: 기존 PostgreSQL ground truth와 결정론적 grader 재사용
- Raw RAG corpus: 현재 `data_source.file_path`에 등록된 원본 446개
- Raw RAG retrieval: raw file path/앞부분 1차 검색 후 원본 chunk 2차 lexical 검색
- MCP: 정규화 + metadata + provenance + coverage + tool 계층

PDF 및 32MiB 초과 파일 등 527개는 raw parser 지원 범위 밖이라 건너뛰었다. Raw RAG도
원본 corpus를 고르는 최소 curation은 필요하므로, 이 실험은 수집 자체가 아니라
semantic 계층의 추가 효과를 비교한다.

### 사전 정의 질문셋(v1) 결과

| 모델 | 지표 | Raw Retrieval | Structured Layer |
| --- | --- | ---: | ---: |
| `gpt-4o-mini` | 정확도 | 60.0% | 80.0% |
|  | 답변 시도율 | 40.0% | 80.0% |
|  | 환각률 (답변 기준) | 25.0% | 25.0% |
|  | 부재 인지 | 100.0% | 66.7% |
|  | 출처 검증 가능 | 0.0% | 59.1% |
|  | 중앙 지연 | 1,360ms | 2,771ms |
| `gpt-5.6-luna` | 정확도 | 60.0% | 80.0% |
|  | 답변 시도율 | 40.0% | 80.0% |
|  | 환각률 (답변 기준) | 25.0% | 25.0% |
|  | 부재 인지 | 100.0% | 66.7% |
|  | 출처 검증 가능 | 0.0% | 50.0% |
|  | 중앙 지연 | 2,830ms | 3,506ms |

두 모델에서 구조화 계층은 정확도와 답변 가능 범위, 검증 가능한 provenance에서
일관되게 우위였지만 모든 지표를
이기지는 않았다. Raw RAG는 부재 문항 3개를 모두 보류했고, MCP는 정책사업 부재 문항에서
보도자료를 근거로 사업을 단정해 실패했다. 경산시 신고 기준 총 세부담액도 Raw RAG는
정답이었지만 MCP는 다른 의미의 값을 반환했다. 따라서 이 결과는 "MCP 연결 자체"가
아니라 semantic 계층이 대체로 개선하되 coverage/지표 선택 회귀는 남아 있음을 보여준다.

산출물:

- `benchmark/reports/raw-rag-vs-mcp-gpt-4o-mini/report.md`
- `benchmark/reports/raw-rag-vs-mcp-gpt-4o-mini/report.json`
- `benchmark/reports/raw-rag-vs-mcp-gpt-5.6-luna/report.md`
- `benchmark/reports/raw-rag-vs-mcp-gpt-5.6-luna/report.json`
- 재실행: `pnpm benchmark:raw-rag -- --model gpt-4o-mini`

## 빈 DB onboarding 실측

### 입력과 격리

- 입력: 649KiB CP949 `국세청_사업자현황_성별(2021년3월).csv`
- 이상 특성: CP949, 반복되는 지역/성별 열, `*` 비공개 값
- 매 실행마다 빈 임시 PostgreSQL database와 임시 inbox/raw store/generated 경로 생성
- 측정 후 임시 database와 파일 삭제
- 운영 DB와 기본 `datasets/`는 수정하지 않음

### 결과

| 단계 | 시간 |
| --- | ---: |
| 빈 DB 생성 | 49ms |
| 검증·인코딩 판정·raw 저장 | 140ms |
| 전체 schema 적용 | 748ms |
| intake 원장 기록 | 217ms |
| catalog 정규화·DB load | 291ms |
| **end-to-end** | **1,745ms** |

파일은 `cp949`, `contentKind=other`로 감지되어 `raw_intake_file` 1행과 `data_source`
1행으로 저장됐다. 프로젝트 범위 밖 국세 자료이므로 인구/지방세 domain fact는 0행이다.
이는 임의 데이터를 억지로 기존 지방세 fact로 변환하지 않고, 원본과 catalog는 보존하되
semantic adapter가 없는 상태를 명시적으로 유지한 결과다.

산출물:

- `benchmark/reports/intake-onboarding-cp949-nts.json`
- 재실행:
  `pnpm experiment:intake-onboarding -- --file <path> --out <report.json>`

## 유지보수성 수치

- 기존 core 변경: +57/-22 LOC, 순증 35 LOC
- 기존 MCP tool 수정: 0개
- Raw RAG 실험 구현: 399 LOC, 테스트 41 LOC
- onboarding 측정기: 159 LOC
- 기존 DB schema 변경: 0 LOC

fresh DB 측정을 위해 intake가 custom dataset/generated 경로를 받을 수 있게 했고, schema를
원장 기록 전에 적용하도록 순서를 보강했다. 측정 중 발견한 두 오류와 폐기한 실행은
`MISTAKE_ISOLATED_INTAKE_STORE_PATH.md`,
`MISTAKE_RAW_RAG_FLAT_SEARCH_OOM.md`에 기록했다.
