# CHANGES: Vanilla vs MCP 비교 벤치마크 신설

## 배경

기존 `evals/` + `packages/evaluation` 벤치마크는 15문항 전 항목 100% 통과다. 이는 성능이 완벽해서가 아니라 **플래너를 자기 카탈로그 기준으로 채점**하기 때문이다. 내부 정합성은 증명하나 "이 시스템이 없을 때와 비교해 무엇이 나아지는가"는 증명하지 못한다.

자체 평가에서 `Innovation & Differentiation` 항목이 16/25로 가장 낮았고, 그 근거가 "API 래퍼를 넘어섰음을 증명할 비교 근거가 없다"는 것이었다. 이 변경은 그 빈칸을 채운다.

## 추가한 것

루트에 `benchmark/` 워크스페이스 패키지(`@gb/benchmark`)를 신설했다. 기존 `evals/`는 건드리지 않았다(성격이 다른 평가이며 병행 유지).

### 구성

| 경로 | 역할 |
| --- | --- |
| `benchmark/cases/gyeongbuk.jsonl` | 22문항. 정답을 값이 아니라 **조회 명세**로 기술 |
| `benchmark/src/ground-truth.ts` | 실행 시점에 PostgreSQL에서 정답 조회, 출처 식별자 실재 확인 |
| `benchmark/src/korean-number.ts` | 한국어 수치 파서 |
| `benchmark/src/grade.ts` | 결정론적 채점 |
| `benchmark/src/arms/{vanilla,mcp,prompt}.ts` | 두 arm과 공용 지시문 |
| `benchmark/src/run.ts` | CLI |
| `benchmark/reports/` | 산출물 |

### 설계상 중요한 결정

1. **정답을 하드코딩하지 않는다.** `{kind: "population_year", region: "포항시", year: 2024}` 같은 명세만 두고 실행할 때 DB에서 읽는다. 데이터가 갱신돼도 정답이 낡지 않는다.
2. **문항 전제를 실행 시 검증한다.** "자료 없음"을 전제한 문항의 값이 DB에 생기면 실행이 중단되고 문항 갱신을 요구한다.
3. **LLM 심판을 쓰지 않는다.** 자기 시스템을 자기 심판으로 평가하면 설득력이 없다. 수치 비교·부재 판정·출처 조회 모두 코드로 판정한다.
4. **vanilla가 이길 수 있는 대조군을 넣는다.** `common_knowledge` 3문항은 일반 모델도 아는 광역 통계다.
5. **MCP arm은 2단계다.** 도구 실행 후 같은 모델에 조회 결과를 되돌려 답변을 합성한다. 실제 MCP 클라이언트의 동작이며, 1단계만 평가하면 접지 효과를 과소평가한다.

## 실행 방법

```bash
pnpm benchmark:compare:dry-run   # 정답 해석·전제 검증만 (API 호출 없음)
pnpm benchmark:compare           # 전체 비교
```

## 결과 (gpt-4o-mini, 22문항)

| 지표 | vanilla | MCP |
| --- | ---: | ---: |
| 정확도 | 18.2% | 77.3% |
| 답변 시도율 | 18.2% | 72.7% |
| 환각률 (답변 대비) | 50.0% | 12.5% |
| 부재 인지 정확도 | 66.7% | 100.0% |
| 출처 검증 가능 비율 | 0.0% | 51.5% |
| 응답 지연 중앙값 | 668ms | 2,546ms |

### 서술상 정정할 점

당초 "MCP가 환각을 줄인다"는 가설로 설계했으나, 실측 결과 **vanilla의 지배적 실패는 환각이 아니라 침묵**이었다(22문항 중 18문항 거부). 지시문을 완전히 제거한 맨 프롬프트로도 동일하게 거부하는 것을 확인했으므로 프롬프트 설계 탓이 아니다.

따라서 이 데이터 계층의 가치는 **"답할 수 없던 질문을 답할 수 있게 만들고, 그 답에 검증 가능한 출처를 붙인다"**로 서술해야 정확하다. 단, vanilla가 답을 하는 순간의 환각률은 50%로 뛴다.

## 벤치마크가 찾아낸 시스템 결함

점수보다 이 목록이 이 작업의 실질적 산출물이다.

| 문항 | 진단 |
| --- | --- |
| `ck-gyeongbuk-pop-2024` | 광역(도) 단위 지역 해석 실패 — 경상북도를 물었는데 포항시 값 반환 |
| `pr-gyeongsan-tax-burden-2024` | `get_local_tax_revenue_trend`가 `amount_semantics`를 인자로 노출하지 않아 '수납액'과 '신고 총 세부담액'을 구분 불가 |
| `pr-press-count-2025` | top-N 결과 개수(5)를 전체 건수(2,770)로 오인 — **집계 도구 부재** |
| `pr-council-seats-ppp` | 정당별 의원 수 집계 도구 부재 |
| `rc-bill-count-2026` | 연도별 의안 건수 집계 도구 부재 |

**최우선 개선 과제는 집계(count/sum/group-by) 도구의 신설**이며, 그 다음이 광역 단위 지역 해석과 지표 정의 선택 인자다.

## 변경한 기존 파일

- `pnpm-workspace.yaml` — `benchmark` 추가
- `package.json` — `benchmark:compare`, `benchmark:compare:dry-run` 스크립트 추가

기존 `evals/`, `packages/evaluation`, `services/mcp-server/src/*`는 수정하지 않았다. 벤치마크는 `runAgent`, `chatClientFromEnv`, `createDataRepository`, `createToolRegistry`만 임포트한다.

## 테스트

`benchmark/src/*.test.ts` 39개. 전부 네트워크·DB 비의존 결정론적 테스트다.

- 한국어 수치 파서 15개
- 채점기 15개 (회귀 테스트 2개 포함, `MISTAKE_BENCHMARK_GRADING_CONTAMINATION.md` 참조)
- 문항 로더 9개 (배포된 22문항 자체를 검증)
