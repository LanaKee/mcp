# Raw RAG vs MCP — 10문항 차별성 실험

- 생성 시각: 2026-08-22T23:35:41.038Z
- 모델: `gpt-4o-mini` (양 arm 동일)
- raw corpus: 446 files / 257894 chunks / 527 skipped
- Raw RAG: 등록된 원본 파일을 단순 lexical retrieval하여 모델에 전달
- MCP: 정규화 + metadata + provenance + coverage + tool 계층

| 지표 | Raw RAG | MCP |
| --- | ---: | ---: |
| 정확도 | 60.0% | 80.0% |
| 답변 시도율 | 40.0% | 80.0% |
| 환각률 (답변 대비) | 25.0% | 25.0% |
| 부재 인지 정확도 | 100.0% | 66.7% |
| 출처 검증 가능 비율 | 0.0% | 59.1% |

| 문항 | Raw RAG | MCP |
| --- | --- | --- |
| `rc-gimcheon-pop-2026` | △ (보류) | O |
| `pr-pohang-tax-2024` | △ (보류) | O |
| `pr-gimcheon-tax-2024` | O | O |
| `pr-gumi-tax-2024` | X (환각) | O |
| `pr-gyeongsan-tax-burden-2024` | O | X (환각) |
| `ab-uljin-pop-2015` | O | O |
| `ab-cheongsong-pop-2024` | O | O |
| `ab-policy-programs` | O | X (환각) |
| `pv-pohang-pop-source` | △ (보류) | O |
| `pv-gimcheon-tax-source` | O | O |

> Raw RAG도 원본 corpus를 고르는 최소 curation은 필요합니다. 이 실험은 정규화·지표 의미·coverage·provenance 계층의 추가 효과를 측정하며, 완전 무가공 수집 비용까지 비교하지는 않습니다.
