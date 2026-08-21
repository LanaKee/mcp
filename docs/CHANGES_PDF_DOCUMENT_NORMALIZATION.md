# PDF 문서 정규화와 임베딩

## 구현

- Node 24에서 동작하는 `pdfjs-dist`로 401개 PDF를 페이지별 추출한다.
- 한글 NFC/공백을 정규화하고 페이지·문단 경계를 넘지 않는 overlap chunk를 생성한다.
- source SHA, document, page, chunk 순번 기반 deterministic key/UUID와 content hash를 쓴다.
- 빈 텍스트는 임베딩하지 않으며 문서/페이지를 `ocr_required` 또는 `extraction_failed`로
  명시한다.
- 기본 384차원 `1-d384` feature-hash provider와 외부 전송을 이중 opt-in한 OpenAI provider를
  구현했다.
- content hash가 같은 기존 embedding은 생성하지 않고 건너뛴다.
- `pnpm pdf:normalize`, `--limit`, `--provider`, `--skip-schema`를 추가했고
  `pnpm db:normalize`에도 PDF 단계를 통합했다.
- PostgreSQL hybrid query/repository는 parameter binding, FTS/trigram candidate, cosine
  rerank를 사용한다.

## 실제 실행

- 파일: 401
- 페이지: 11,712
- chunk: 17,487
- extraction/OCR failure: 0
- 로컬 embedding: 17,487

기본 embedding은 의미 모델이 아니라 retrieval-only lexical hash다.
