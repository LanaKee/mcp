# 공식 도정 업무계획 문서 적재

## 변경

- `datasets/extra/dojeong_2020.pdf`~`dojeong_2026.pdf` 7개를 재귀 catalog에 포함했다.
- 읽을 수 있는 2021·2023·2025·2026 문서는 `provincial_work_plan`으로 분류하고
  파일명의 연도를 본문 `업무계획`/연도 marker와 대조했다.
- 공식 문서 passage는 `search_policies.result.official_document_passages`로 별도
  반환한다. 기존 `policy_program` demo 자격 판단과 합치거나 공식 자격 결론으로
  변환하지 않는다.
- PDF 문서/페이지에 text classification, extraction method, 한국어 plausibility
  지표를 저장하고 unusable page를 chunk/embedding/search에서 제외한다.
- 2020·2022·2024는 page count/hash/evidence/exclusion reason만 catalog/DB에
  보존하고 content ingestion은 수행하지 않는다.

## 전체 재처리 결과

| 연도 | 문서 분류 | 페이지 | 검색 chunk | 제외 이유 |
|---:|---|---:|---:|---|
| 2020 | `mojibake_suspected` | 96 | 0 | broken CMap/CID mojibake |
| 2021 | `extracted_ok` | 94 | 127 | - |
| 2022 | `mojibake_suspected` | 100 | 0 | broken CMap/CID mojibake |
| 2023 | `extracted_ok` | 104 | 165 | - |
| 2024 | `unusable_for_retrieval` | 135 | 0 | no usable text layer |
| 2025 | `extracted_ok` | 113 | 185 | - |
| 2026 | `extracted_ok` | 168 | 293 | - |

2024의 6페이지는 text도 visual operator도 없는 `empty`로 분류했다. 좋은 문서 안의
text-layer 없는 13페이지도 page provenance와 제외 분류는 남기되 검색 text를 만들지
않았다.

전체 408개 문서는 12,522페이지, current chunk/embedding 24,565개다. 기존 401개
회의록 corpus를 별도로 재검사한 결과 11,712페이지 모두 `extracted_ok`였고 새
mojibake/unusable 분류는 0건이었다. Golden 6/6, excluded-page chunk 0건이다.
동일 입력 DB 재실행은 insert 0, run 중 신규 embedding 0이었고 current count를
그대로 유지했다. unusable 3개 문서는 실패를 숨기지 않고 exclusion report에 남는다.

`청년 스마트팜` PostgreSQL smoke는 438.1ms에 2023 업무계획 81쪽 passage와
`native_pdf_text` provenance를 반환했다. 이 측정은 단일 로컬 실행이며 일반적인
latency 보장은 아니다.

## 한계

- Golden은 2026 표지의 짧은 marker와 기존 회의록 구조 표본만 검증한다. 전체 문장
  정확도, 표 셀 관계, 법적 완전성을 증명하지 않는다.
- OCR engine/queue/provider는 이번 범위에 포함하지 않았다. 2020·2022·2024 재수집은
  향후 별도 승인된 source replacement 또는 OCR 결정이 필요하다.
- 읽을 수 있는 업무계획 passage도 공고문이 아니므로 신청 자격·지원액의 최종 근거가
  아니다.
