# 데이터 사전

## 공통 상태

| 값 | 의미 |
|---|---|
| `official_observed` | 제공된 원천 파일에서 파싱한 관측값. 원출처 재확인 필요 |
| `demo_sample` | 기능 테스트용 재배포 가능 예시. 공식 사실이 아님 |
| `catalog_only` | 파일 존재·해시·위치만 확인했고 본문/수치는 파싱하지 않음 |

## 핵심 테이블

### `dim_region`

| 컬럼 | 설명 |
|---|---|
| `region_id` | canonical 행정구역 키 |
| `region_name` | 표시 명칭 |
| `region_type` | province/city/county/district/town |
| `parent_region_id` | 상위 행정구역 |
| `normalized_name` | 공백·접두어 정규화 명칭 |

### `data_source`

출처 제목, 제공기관, URL, 라이선스, 원본 상대경로, SHA-256, 수집시각, 기준일,
미디어 형식, 공식 여부와 `data_status`를 보관한다.

### `ingestion_run`

파이프라인명·버전, 시작/종료, 상태, 입력 해시, insert/update/error 수와 오류 보고서를
기록한다. 같은 입력 해시의 재실행 여부를 판단할 수 있다.

### `population_observation`

지역·기준일별 총인구, 성별 인구, 세대수, 외국인 수, 출처와 원본 행 번호를 저장한다.
샘플 CSV의 `population_total` 단위는 명이다.

### `local_tax_revenue`

지역·회계연도·세목별 지방세 금액(원)과 예산/결산 기준을 저장한다. **국세는 범위
밖**이다. 현재 저장소 샘플은 모두 가상 결산값이다.

### `policy_program`

지역, 정책명, 주관기관, 최소/최대 나이, 산업, 창업 단계, 자격 설명, 지원 내용,
신청기간과 원출처를 저장한다.

### `council_record`

의회, 회기, 회의일, 안건번호, 제목, 발의자, 처리결과와 출처를 저장한다.

### `document` / `document_chunk`

정책·회의록·첨부문서 등의 메타데이터와 검색 단위 텍스트를 분리한다. chunk에는
임베딩 모델/차원/데이터 필드가 있지만 현재 기본 검색은 lexical 방식이다.

### `source_locator`

엔터티 키를 원본 페이지, 행, 절, 문자 범위 또는 사람이 읽을 수 있는 locator와
연결한다.

## 샘플 파일

| 파일 | 범위 | 상태 |
|---|---|---|
| `population.csv` | 포항·상주·김천·구미, 2022~2024 | `demo_sample` |
| `local-tax.csv` | 위 시군 지방세 합계 가상 결산값 | `demo_sample` |
| `policies.json` | 상주/경북 스마트팜 가상 정책 3건 | `demo_sample` |
| `council-records.json` | 2020~2024 지방소멸 가상 요약 | `demo_sample` |
| `sources.json` | 샘플 출처와 비공식 경고 | `demo_sample` |

