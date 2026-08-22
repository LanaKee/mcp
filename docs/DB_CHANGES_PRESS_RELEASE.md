# DB 변경: `press_release` 테이블 추가

마이그레이션: `db/migrations/015_gyeongbuk_press_release.sql`

## 왜 별도 테이블인가

보도자료를 기존 테이블에 밀어 넣을 수 있는 후보는 두 개였다.

- `document` — PDF 원문용. 페이지·청크·임베딩 파이프라인이 붙어 있어서
  게시판 HTML 본문에는 맞지 않는다.
- `council_record` — 서술형 텍스트라는 점은 비슷하지만 의회 안건 전용 컬럼
  (`session_name`, `agenda_number`, `proposer`, `resolution`)이 모두 NULL이 된다.

무엇보다 **의미가 다르다**. 보도자료는 도가 발표한 계획·홍보이고, 의회 안건은
의결 대상이다. 같은 테이블에 두면 `search_council_records`가 두 종류를 섞어
돌려주게 되어 근거의 성격을 구분할 수 없다.

## 스키마

```sql
CREATE TABLE press_release (
  press_release_id text PRIMARY KEY,
  region_id text REFERENCES dim_region(region_id),
  mentioned_region_ids text[] NOT NULL DEFAULT '{}',
  issuing_organization text NOT NULL,
  department text,
  contact_phone text,
  author text,
  title text NOT NULL,
  body text NOT NULL,
  body_sha256 char(64) NOT NULL,
  body_char_count integer NOT NULL CHECK (body_char_count >= 0),
  published_date date,
  published_at timestamptz,
  view_count integer CHECK (view_count IS NULL OR view_count >= 0),
  attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  detail_url text NOT NULL,
  source_record_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES data_source(source_id),
  ingestion_run_id uuid REFERENCES ingestion_run(ingestion_run_id),
  data_status text NOT NULL CHECK (data_status = 'official_observed'),
  content_classification text NOT NULL CHECK (
    content_classification IN (
      'extracted_ok', 'mojibake_suspected', 'unusable_for_retrieval'
    )
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
```

## 설계 근거

### `data_status`에 `demo_sample`을 허용하지 않는다

다른 테이블은 `CHECK (data_status IN ('official_observed', 'demo_sample'))`이지만
여기서는 `= 'official_observed'`로 고정했다. 보도자료는 실제 게시판에서 수집한
공식 발표만 존재한다. 데모 변형을 허용하면 "예시로 만든 보도자료"가 맥락으로
섞여 나갈 수 있다.

### `press_release_id`는 게시판 id에서 파생한다

`gb-press-<B_STEP>` 형태다. 스냅샷 파일의 sha256이 아니라 게시물 자체의 id를
쓰므로, 나중에 다시 크롤해서 `source_id`가 바뀌어도 같은 발표가 한 행으로
갱신된다.

`source_record_id`에 UNIQUE 인덱스를 걸어 이 불변식을 DB 수준에서도 지킨다.
`(source_id, source_row)` 방식을 썼다면 재크롤 때마다 사본이 쌓였을 것이다.
(`MISTAKE_PATH_ADDRESSED_SOURCE_IDENTITY.md` 참고)

### `region_id`와 `mentioned_region_ids`의 구분

- `region_id` = `47` (경상북도). 발표 주체이므로 사실이다.
- `mentioned_region_ids` = 본문에 이름이 등장한 시군. **추정**이다.

두 개를 한 컬럼에 합치면 "청도군이 발표했다"로 읽힐 수 있어 분리했다.
컬럼 주석에도 "keyword heuristic, not an assertion"이라고 남겼다.

### `content_classification`

`document`와 같은 어휘를 쓰되 `'empty'`는 없다. 본문이 빈 게시물은
`unusable_for_retrieval`로 분류한다. 검색 쿼리는 `extracted_ok`만 대상으로 하며,
본문 FTS 인덱스도 같은 조건의 partial index다.

### `body_sha256`

같은 내용이 재게시되었는지, 크롤 결과가 바뀌었는지 비교하기 위한 값이다.
PK로는 쓰지 않는다 — 오탈자 수정으로 본문이 바뀌어도 같은 게시물이기 때문이다.

## 인덱스

| 인덱스 | 목적 |
| --- | --- |
| `press_release_published_date_idx` | 최신순 정렬 및 기간 필터 |
| `press_release_department_idx` | 부서 필터 (partial, NOT NULL) |
| `press_release_mentioned_regions_idx` | GIN, `= ANY(...)` 시군 매칭 |
| `press_release_title_fts_idx` | 제목 FTS |
| `press_release_body_fts_idx` | 본문 FTS (partial, `extracted_ok`만) |
| `press_release_title_trgm_idx` | 한글 부분일치 (`%` 연산자) |
| `press_release_source_record_idx` | UNIQUE, 재크롤 시 중복 방지 |

한국어 전용 FTS configuration이 없으므로 기존 코드와 동일하게 `'simple'`을 쓰고,
부족한 부분은 `pg_trgm` 유사도와 `ILIKE` 부분일치로 보완한다.

## 적재 경로

`load-plan.ts`가 `plan.pressReleases`를 만들고 `db.ts`가
`ON CONFLICT (press_release_id) DO UPDATE`로 upsert한다. `source_locator`에도
`entity_type = 'press_release'` 행을 남겨 검색 결과에서 원본 위치를 되짚을 수 있다.

무결성 리포트(`integrityCounts`)에 `press_release` 집계를 추가했다.

## 롤백

```sql
DROP TABLE IF EXISTS press_release;
DELETE FROM source_locator WHERE entity_type = 'press_release';
```

다른 테이블이 `press_release`를 참조하지 않으므로 단독으로 되돌릴 수 있다.
