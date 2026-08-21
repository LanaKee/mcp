# PDF와 임베딩 스키마 변경

`db/migrations/003_pdf_documents_embeddings.sql`을 추가했다.

## `document`

- deterministic `document_key`
- `ingestion_run_id`
- extraction status/page count/content hash

## `document_chunk`

- deterministic `chunk_key`/UUID
- page start/end와 content hash
- `ingestion_run_id`, `is_current`
- content trigram, document/page/current 인덱스

## `document_chunk_embedding`

provider/model/version별 `real[]` embedding과 차원 check를 저장한다. provider별 차원이
달라질 수 있으므로 기존 JSONB나 하나의 고정차원 vector 컬럼을 사용하지 않았다.
현재 corpus에서는 FTS/trigram으로 bounded 후보를 만든 뒤 array cosine을 계산한다.
pgvector ANN은 corpus/model 규모가 커질 때 provider+dimension partition별 migration으로
추가하는 것이 안전하다. 현재 필수 extension은 기존 schema의 `pgcrypto`, `pg_trgm`이다.

기존 행은 migration에서 deterministic legacy key, page 기본값, content hash를 backfill한다.
스키마 적용기는 기존 테이블이면 migration을 먼저 실행해 새 index가 없는 컬럼을
참조하지 않도록 한다.
