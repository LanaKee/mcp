# DB 변경: 공식 원본 소스의 콘텐츠 주소화 (migration 014)

## 요약

`data_source.source_key` 의 생성 규칙을 **경로 기반**에서 **내용(해시) 기반**으로 변경했다.

| | 이전 | 이후 |
| --- | --- | --- |
| 규칙 | `official:<파일경로>:<sha256>` | `official:<sha256>` |
| 동일 바이트가 두 경로에 있을 때 | 소스 2건 | 소스 1건 |

관련 마이그레이션: `db/migrations/014_content_addressed_sources.sql`

## 왜 바꿨나

모든 사실(fact) 테이블은 `UNIQUE (source_id, source_row)` 로 자연키가 잡혀 있다.
즉 **소스 정체성이 곧 사실의 정체성**이다.

`source_key` 에 파일 경로가 들어 있었기 때문에, 같은 파일이 두 경로에 존재하면
`source_key` 가 갈라지고 → `source_id` 가 두 개 생기고 → `(source_id, source_row)` 충돌이
일어나지 않으므로 → **동일한 사실이 조용히 2배로 적재**되었다.

실제로 신규 데이터 적재 파이프라인을 검증하던 중, intake 가 파일을
`datasets/new/` 에서 `datasets/local-tax/` 로 라우팅한 뒤
`local_tax_per_capita_burden` 의 청도군(47820) 2020·2021·2022년 값이 각각 2건씩
중복 적재된 것을 확인했다. (18행 → 정상은 15행)

intake 저장소는 이미 SHA-256 으로 중복을 거르므로, 데이터베이스의 정체성 규칙도
같은 기준을 따르는 것이 일관적이다.

## 마이그레이션 동작

`014_content_addressed_sources.sql` 는 단일 트랜잭션에서:

1. `file_sha256` 가 같은 공식 소스를 묶고 `(file_path, source_id)` 순으로 순위를 매겨
   1순위를 정본(canonical)으로 삼는다. 2순위 이하가 제거 대상이다.
2. 제거 대상의 종속 행을 FK 안전 순서로 삭제한다.
   `document_chunk_embedding` → `document_chunk` / `document_page` /
   `document_processing_version` → `document` → `source_locator` →
   `council_record` / `population_observation` / `policy_program` /
   `data_quality_issue` / `local_tax_*` 8개 테이블 → `data_source`
3. 남은 공식 소스의 `source_key` 를 `'official:' || file_sha256` 로 갱신한다.

중복이 없으면 임시 테이블이 비어 있어 모든 DELETE 가 0행이고,
`source_key` 도 이미 목표 형태이므로 UPDATE 역시 0행이다. 즉 **멱등이며 무해**하다.
`applyDatabaseSchema` 가 매 실행마다 전체 마이그레이션을 재적용하므로 이 성질이 필수다.

정본을 `(file_path, source_id)` 로 고르는 이유는 결정적(deterministic)이기 때문이다.
어느 쪽을 남겨도 내용은 동일하며, 다음 `db:normalize` 가 카탈로그 기준으로
경로·메타데이터를 다시 채운다.

## 적용 결과 (로컬 검증 DB)

```
              적용 전   적용 후
data_source     452      451
per_capita       18       15   (청도군 중복 3건 제거)
중복 sha 그룹     1        0
경로 기반 key   451        0
```

마이그레이션 직후 `db:normalize --skip-pdf` 를 재실행해도 수치가 그대로 유지되어
(451 / 15 / 0) 재적재가 중복을 다시 만들지 않음을 확인했다.

원격 운영 DB 는 검사 시점에 중복 SHA 그룹이 0건이었다. 따라서 이 마이그레이션은
운영 DB 에서는 `source_key` 형식만 정규화하며 데이터 삭제가 발생하지 않는다.

## 코드 변경

- `pipelines/src/load-plan.ts` — `officialSourceKey(fileSha256)` 로 시그니처 축소.
  호출부 5곳 수정.
- `pipelines/src/pdf.ts` — 호출부 1곳 수정.
- `pipelines/src/db.ts` — `MIGRATION_FILES` 에 `014_content_addressed_sources.sql` 등록.
- `pipelines/src/load-plan.test.ts` — 동일 바이트가 두 경로에 있을 때 소스가 1건으로
  합쳐지고 사실이 중복되지 않는지 검증하는 회귀 테스트 추가.

`source_key` 에서 경로를 되파싱하는 코드는 없으므로 읽기 경로 영향은 없다.
`createLoadPlan` 은 이미 `uniqueBy(plan.sources, sourceKey)` 를 수행하므로
키가 합쳐져도 INSERT 충돌이 발생하지 않는다.

## 남은 위험

`council_record.council_record_id` 는 여전히 경로를 포함해 파생된다
(`deterministicCouncilId`). 같은 의회 CSV 가 두 경로에 존재하면 소스는 1건으로
합쳐지지만 의회 레코드 ID 는 갈라져 중복될 수 있다.

지금 바꾸지 않은 이유는 이 ID 가 MCP 도구 응답으로 외부에 노출되는 안정 식별자이고,
변경 시 49,708건 전체가 churn 되기 때문이다. 정상 운영 경로에서는 intake 저장소가
동일 바이트의 재유입을 차단하므로 노출 가능성이 낮다. 수동 파일 복사로 이 조건을
만들지 않도록 주의한다.
