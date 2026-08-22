# PDF 페이지 품질 스키마 변경

`db/migrations/006_pdf_page_quality.sql`을 추가했다.

## `document_page`

- extractor-versioned deterministic `page_key`/UUID
- raw/cleaned content SHA-256와 extraction status/error
- 문자 수, 한글/제어 glyph/의심 공백 비율
- 반복 header/footer, table-like line/density, speaker marker 수
- `empty`/`near_empty`/`substantive` 분류와 JSON metadata
- document/page 조회 및 current quality 인덱스
- `(document_id, page_number) WHERE is_current` partial unique index

적재기는 문서의 이전 page version을 stale로 표시한 뒤 현재 page를 upsert하고 모든 page에
`document_page` source locator를 만든다.

## `document_chunk`

기존 `UNIQUE(document_id, chunk_index)`를 제거했다. 앞 page의 chunk 수가 바뀌면 뒤 page의
global index가 이동해 versioned deterministic `chunk_id`와 충돌하던 제약이었다.
`chunk_key` unique와 current flag가 logical identity/current 검색을 담당한다.

## 운영

- schema와 migration 006은 동일 구조를 유지한다.
- loader integrity는 current/stale chunk, current page quality, current embedding을 구분한다.
- extractor/chunker version 변경 행은 자동 삭제하지 않는다. 승인된 retention과
  VACUUM 정책이 별도로 필요하다.
