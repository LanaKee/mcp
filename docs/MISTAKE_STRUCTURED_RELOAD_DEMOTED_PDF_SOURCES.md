# 구조화 데이터 재적재의 PDF source 강등

## 문제

`db:load`와 `db:normalize --skip-pdf`는 catalog의 PDF 상태(`catalog_only`)를
`data_source` conflict update에 그대로 써서, 이전 PDF 정규화가
`official_observed`로 승격한 읽기 가능한 문서 source까지 다시 강등했다. chunk와
embedding은 남았지만 source context 상태가 부정확해졌다.

## 원인과 수정

구조화 적재기와 PDF 적재기가 같은 `data_source` 행을 갱신하면서 소유하는 필드를
구분하지 않았다. 구조화 적재기는 PDF source를 최초 catalog할 수는 있지만 conflict
시 `data_status`와 extraction 품질 `metadata`를 갱신하지 않도록 분리했다. 이 두
필드는 PDF 품질 gate와 PDF DB loader만 승격·갱신한다.

## 예방

전체 PDF 적재 후 구조화 `db:load --skip-schema`를 다시 실행하고도 source 상태가
공식 454, catalog-only 3이며 current chunk/embedding 24,565개가 유지되는지 검증한다.
