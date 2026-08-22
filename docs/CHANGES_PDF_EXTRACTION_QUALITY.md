# PDF 추출·chunk 품질 평가

## 구현

- local PDF 4개에서 plenary, audit committee, table-heavy agenda, dense speaker transition,
  alternating running header를 대표하는 5개 page golden을 만들었다.
- fixture에는 source path/SHA-256, page, raw text hash, 짧은 marker와 구조 임계값만 저장하며
  페이지 전문은 복제하지 않는다.
- `document_page` 계획에 raw/cleaned hash, 문자 수, 한글/제어 glyph/의심 공백 비율,
  반복 margin, 표 유사도, 발언자 수, empty/near-empty 분류를 추가했다.
- 같은 문서의 상·하단 3줄에서 최소 50%/3페이지 이상 반복되고 header-like한 줄만
  제거한다. `다음 N쪽입니다.`와 문장형 반복 본문은 보존한다.
- PDF item X 간격이 큰 위치는 tab으로 보존하고 table-like 연속 행은 줄 단위 segment로 묶는다.
- `○의장`, `○위원장`, `○김응숙위원`, `○사회복지과장` 등의 전환을 인식한다.
  발언 turn은 원자적으로 유지하고 max chunk 절단은 turn 사이에서만 수행한다.
- embedding은 batch callback으로 즉시 PostgreSQL에 적재해 전체 vector를 메모리에 보관하지 않는다.
- `pnpm pdf:evaluate`는 golden과 corpus 분포를 `data/generated/pdf.quality.report.json`에
  기록한다. 생성 report는 Git 제외 대상이다.

## severe regression gate

- golden pass rate가 100% 미만
- page extraction failure가 평가 page의 1% 초과
- excluded(`mojibake_suspected`/`unusable_for_retrieval`/`empty`) page에서 chunk가 생성됨
- 읽을 수 있는 정책 문서의 유형/연도 evidence 검증 실패

unusable page 증가는 결함을 올바르게 찾은 결과일 수 있으므로 그 자체로 실패시키지
않는다. 그 밖의 분포 변화는 report하되 자동 실패시키지 않는다.

## 당시 baseline corpus 결과

- 401 PDF / 11,712 page, extraction failure 0, OCR-required 0
- golden 5/5 통과
- substantive 11,607 page, near-empty 105 page
- table-likely 12 page, speaker-rich 7,975 page
- 반복 header 543줄 제거, 실제 반복 footer 검출 0줄
- 현재 chunk/embedding 23,795개
- chunk 평균 576자, 중앙값 497자, p95 1,180자
- 동일 입력 재실행: insert 0, embedding 생성 0, 23,795개 skip
- hybrid 검색 3개 질의: 209.1ms, 261.0ms, 290.4ms

엄격히 발언자마다 한 chunk를 만든 중간 설계는 126,469 chunk, 중앙값 47자,
40자 미만 55,488개를 만들어 폐기했다. turn 원자성을 유지하면서 한 page의 완결된
turn을 bounded packing하는 방식으로 바꿔 현재 chunk를 23,795개로 줄였다.

## 한계

- golden은 local 4개 PDF의 5페이지 구조 회귀이며 전체 의미 정확도를 입증하지 않는다.
- corpus에서 고신뢰 반복 footer가 발견되지 않아 footer 제거는 합성 unit test만 있다.
- table-likely는 layout/tab/숫자 heuristic이며 셀 구조 복원이나 표 의미 이해가 아니다.
- 별도 text recovery와 semantic embedding은 포함하지 않는다.

## 후속 정정

새 도정 업무계획에서 Hangul codepoint를 내는 CID mojibake가 발견되어 당시
Hangul-ratio 중심 품질 지표를 보강했다. 현재 408 PDF 결과와 오판 원인은
`CHANGES_POLICY_DOCUMENT_INGESTION.md`와
`MISTAKE_HANGUL_RATIO_MOJIBAKE_BLINDSPOT.md`를 따른다. 기존 401 PDF를 새 gate로
재검사한 결과는 11,712페이지 모두 `extracted_ok`였다.
