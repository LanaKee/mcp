# DB 변경: 정책 PDF text 품질과 검색 제외

Migration: `010_policy_document_text_quality.sql`

## 추가 컬럼

- `document`: `content_classification`, `extraction_method`
- `document_processing_version`: version별 같은 두 필드
- `document_page`: classification/method와 Hangul count, 행정 용어 hit rate,
  valid bigram, rare syllable, 조사, whitespace, 숫자·문장부호, mojibake score

기존 행은 extraction 상태에 따라 안전한 초기값을 한 번만 채운다. migration 재실행은
이미 분류된 결과를 덮어쓰지 않는다.

## 제외 상태

`mojibake_suspected`, `unusable_for_retrieval`, `empty`는 raw/page hash와 품질
evidence를 보존하지만 검색 text를 만들지 않는다. 문서 metadata에
`retrievalExcluded`와 bounded exclusion reason을 기록한다. OCR table, queue,
provider 또는 credential 컬럼은 추가하지 않는다.

## 검색 invariant

production 검색은 기존 lifecycle 조건에 더해
`document.content_classification = 'extracted_ok'`만 허용한다. 승인 switch는
`document_processing_version`의 classification/method도 원자적으로 base document에
반영한다.
