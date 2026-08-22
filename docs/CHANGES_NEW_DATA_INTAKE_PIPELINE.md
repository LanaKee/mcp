# 신규 데이터 반입(intake) 파이프라인

## 배경

기존 파이프라인은 `datasets/` 전체를 매번 다시 훑어 정규화·적재하는 구조만 있었다.
새 파일이 도착했을 때 "무엇을 어디에 저장할지", "이미 가진 파일인지", "깨진 파일을
그대로 창고에 넣지 않을지"를 판단하는 단계가 없었다. 운영자가 파일을 직접
`datasets/` 아래에 복사한 뒤 전체 ETL을 다시 돌리는 수작업에 의존했고, 그 과정에서
다음 위험이 남아 있었다.

- 같은 자료를 이름만 바꿔 두 번 넣어도 걸러지지 않는다.
- 포털이 반환한 HTML 오류 페이지가 `.csv` 확장자로 저장돼도 그대로 창고에 들어간다.
- 같은 파일명으로 갱신본이 오면 기존 원본을 덮어써 원출처 추적이 끊긴다.
- 어떤 원천이 언제 들어왔고 왜 사실로 전환되지 않았는지 남는 기록이 없다.

## 도입한 구조

반입은 **접수 → 검증 → 중복 판정 → 저장 → 가공 → 원장 기록**의 6단계로 고정했다.

```
data/intake/inbox/  ──▶ 검증 ──▶ 중복 판정 ──▶ datasets/<category>/  ──▶ ETL/적재
                         │           │
                         │           └─▶ data/intake/duplicates/<runId>/
                         └─▶ data/intake/quarantine/<runId>/ + .error.json
```

작업 공간은 `datasets/` 밖의 `data/intake/`에 둔다. 격리·중복 파일을 `datasets/`
안에 두면 ETL이 그 파일까지 catalog에 올려 버리기 때문이다.

### 1. 접수

`data/intake/inbox/`(기본값)에 놓인 모든 파일을 재귀적으로 읽는다. 점(`.`)으로
시작하는 항목은 건너뛴다. inbox가 없으면 무동작으로 끝난다.

한 번에 하나의 반입만 실행되도록 `data/intake/intake.lock`을 `wx` 모드로 만들어
배타 잠금을 건다. 동시 실행이 같은 저장 경로를 두고 경쟁하면 원본이 유실될 수 있다.

### 2. 검증

`validateIntakePayload`가 확장자와 실제 바이트가 일치하는지 확인한다. 거부 사유는
코드로 남는다.

| 코드 | 의미 |
| --- | --- |
| `unsupported_extension` | 허용 형식(csv/xlsx/hwpx/pdf/json/xml)이 아님 |
| `empty_file` | 0바이트 |
| `file_too_large` | 크기 상한(기본 512MiB) 초과 |
| `signature_mismatch` | PDF가 `%PDF-`로 시작하지 않거나 xlsx/hwpx가 ZIP이 아님 |
| `html_error_page` | 데이터 대신 HTML 페이지가 저장됨 |
| `undecodable_text` | UTF-8·CP949 모두에서 복원 불가 문자가 남음 |
| `unparsable_content` | CSV/JSON 파싱 실패 |
| `no_data_rows` | 헤더만 있고 데이터 행이 없음 |

거부된 파일은 삭제하지 않고 `data/intake/quarantine/<runId>/`로 옮기며 같은 이름의
`.error.json` 사이드카에 사유·해시·크기를 남긴다. 사람이 원본을 다시 확인할 수 있어야
하기 때문이다.

### 3. 중복 판정

원본 창고를 SHA-256 기준 내용 주소로 색인한다(`buildStoreIndex`). 해시가 이미
존재하면 파일명이 달라도 `duplicate`로 판정하고 저장하지 않는다. 한 배치 안에 같은
내용이 두 번 들어와도 첫 번째만 저장한다.

색인은 `data/generated/intake-store-index.json`에 (경로, 크기, mtime, 해시)로
캐시한다. 크기와 mtime이 모두 일치할 때만 캐시 해시를 재사용하므로, 파일이 바뀌면
반드시 다시 해싱한다.

### 4. 저장

내용 유형에 따라 창고 하위 디렉터리를 결정한다. 파일명이 아니라 헤더로 판정한
`contentKind`를 쓰기 때문에 이름이 불규칙해도 같은 종류는 같은 곳에 모인다.

| contentKind | 저장 위치 |
| --- | --- |
| `local_tax_*`, `property_valuation_microdata` | `datasets/local-tax/` |
| `population*` | `datasets/population/` |
| `council_agenda` | `datasets/council/` |
| `pdf_document` | `datasets/documents/` |
| 그 외 | `datasets/misc/` |

같은 이름이 이미 있고 내용이 다르면 덮어쓰지 않고 `이름__r2.csv`처럼 개정본으로
저장한다(`revision`). 원본과 개정본은 각각 별도의 `data_source`가 되므로 어떤 수치가
어느 판본에서 나왔는지 계속 추적된다.

이동은 목적지 디렉터리에 `.intake-partial` 임시 이름으로 옮긴 뒤 최종 이름으로
rename 한다. 다른 파일 시스템이면 복사 후 원본을 지운다. 최종 rename 직전에 목적지
존재 여부를 다시 확인하고, 계획 이후에 파일이 생겼다면 원본을 inbox로 되돌리고
실패시킨다. 창고 파일을 조용히 덮어쓰는 것보다 실패가 낫다.

### 5. 가공

새 바이트가 실제로 창고에 들어왔을 때만(`accepted + revision > 0`) 정규화와 적재를
수행한다. 변한 것이 없는데 전체 ETL을 다시 도는 것은 시간만 쓴다.

가공은 기존 `db-cli normalize`와 같은 경로를 쓴다. 중복 구현을 막기 위해 해당 로직을
`process.ts`의 `normalizeAndLoad`로 추출했고 `db-cli`도 이 함수를 호출한다. 적재는
upsert 기반이라 같은 창고를 다시 처리해도 사실이 중복되지 않는다.

### 6. 원장 기록

반입 결과는 `ingestion_run`(pipeline_name `dataset-intake`)과 신설
`raw_intake_file`에 남는다. 저장된 파일뿐 아니라 중복·격리된 파일까지 모두 기록하므로
"들어왔지만 사실이 되지 않은 원천"을 조회할 수 있다. 격리가 한 건이라도 있으면 실행
상태는 `partial`이다.

실행 요약은 `data/intake/manifests/`에도 JSON으로 남아 DB 없이도 감사할 수 있다.

## 사용법

```bash
# 계획만 확인한다. 파일은 움직이지 않는다.
pnpm intake:dry-run

# 반입 + 정규화 + 적재 + 원장 기록
pnpm intake

# 저장만 하고 가공은 나중에
pnpm intake --skip-process

# 원장 요약
pnpm intake:status
```

주요 옵션은 `--inbox`, `--workspace`, `--max-bytes`, `--skip-pdf`, `--skip-ledger`,
`--pdf-limit`, `--embedding-provider`, `--allow-external`이다.

## 재실행 안전성

- 같은 파일을 다시 넣으면 `duplicate`로 끝나고 창고는 변하지 않는다.
- 같은 반입 실행을 두 번 기록해도 원장 행은 늘지 않는다.
- `stored_path`에는 부분 유니크 인덱스가 있어 한 저장 경로를 두 원천이 주장할 수 없다.
- dry-run은 파일 이동, manifest, 원장 기록을 모두 수행하지 않는다.

## 변경 파일

- `pipelines/src/intake.ts` 반입 계획·실행 로직
- `pipelines/src/intake-db.ts` 원장 기록과 요약
- `pipelines/src/intake-cli.ts` CLI
- `pipelines/src/process.ts` `db-cli`와 공유하는 정규화·적재 단계
- `pipelines/src/catalog.ts` 분류 로직을 `describeDatasetFile`로 추출해 공유
- `pipelines/src/db.ts` 마이그레이션 목록을 `MIGRATION_FILES` 배열로 정리
- `db/migrations/013_raw_intake_ledger.sql`, `db/schema.sql`
