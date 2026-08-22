# 데이터 파이프라인 비판적 검토

## 검토 증거

- 실제 401개 PDF, 11,712페이지를 전부 재추출·평가·PostgreSQL 적재했다.
- extraction failure/OCR-required는 0페이지였고 substantive 11,607, near-empty 105였다.
- local 4개 PDF의 5개 golden page가 source/page/raw hash와 짧은 구조 marker를 모두 통과했다.
- table-likely 12페이지, speaker-rich 7,975페이지, suspicious-spacing 214페이지,
  control-glyph 98페이지였다.
- 고신뢰 반복 header 543줄을 제거했다. 실제 반복 footer 표본은 0개였다.
- current page 11,712개는 locator 11,712개와 일치했고 current 문서·page 중복 및
  embedding 누락은 0이었다.
- 최종 current chunk/embedding은 23,795개다. 평균 576자, 중앙값 497자, p95 1,180자,
  40자 미만 2,157개였다.
- 동일 입력 재실행은 insert 0, embedding 생성 0, unchanged embedding 23,795개 skip이었다.
- PostgreSQL hybrid 검색은 `지방소멸` 209.1ms, `청년 정착` 261.0ms,
  `행정사무감사` 290.4ms였고 모두 page/title provenance를 반환했다.
- gated PostgreSQL integration 3건이 page 품질/source locator까지 통과했다.

## 이번 P1에서 수정한 고신뢰 문제

### 반복 margin false positive

단순 빈도 기반 제거는 반복 본문을 지울 위험이 있었다. 상·하단 3줄, 3페이지 이상,
문서 page의 50% 이상, page/header-like 패턴이라는 조건을 모두 만족할 때만 제거한다.
`다음 N쪽입니다.`와 문장형 반복 본문 보존을 unit test로 고정했다. 제거 원문은 저장하지
않고 raw page hash와 제거 line hash를 남긴다.

### 발언자 경계와 chunk 폭증

발언자마다 하나의 chunk를 만든 중간 설계는 126,469 chunk, 중앙값 47자,
40자 미만 55,488개로 저장·검색 품질을 악화시켰다. 발언 turn 자체는 원자적으로 유지하되
한 page 안의 완결된 turn을 1,200자 한도로 packing하고 절단은 turn 사이에서만 수행하도록
수정했다. 최종 chunk는 23,795개, 중앙값 497자로 줄었다.

### layout/table 손실

PDF text item의 큰 X 간격을 tab으로 보존하고 tab/숫자 cell/leader 기반 table-like 연속
행을 줄바꿈 상태로 묶는다. 이는 구조 보존 개선이지 셀 병합·열 의미 복원은 아니다.

### version 충돌과 메모리

앞 page chunk 수가 바뀔 때 `UNIQUE(document_id, chunk_index)`가 뒤 page의 versioned ID와
충돌할 수 있어 migration 006에서 제거했다. embedding은 생성 batch마다 transaction 안에서
upsert해 23,795개 vector 전체를 Node heap에 쌓지 않는다. source context는 stale page/chunk
locator를 제외한다.

## 영역별 남은 위험

### 정확성·데이터 품질

- golden은 4개 문서 5페이지의 구조 회귀이며 전체 문장 정확도나 법적 완전성을 입증하지 않는다.
- 실제 반복 footer가 없어 footer 제거는 합성 test만 있다.
- PDF glyph 순서, 다단 편집, 병합 셀은 PDF.js reading order와 다를 수 있다.
- near-empty 105페이지는 자동 오류가 아니다. 표지/서식일 수 있어 검토 queue가 필요하다.
- 날짜/기관은 일부 파일명 추론이므로 표지와 불일치할 수 있다.

### 개인정보·비용

- 기본 `hashed-korean-token`은 로컬 결정적 계산이며 네트워크/유료 API를 쓰지 않는다.
- OpenAI는 provider, `--allow-external`, API key가 모두 있어야 전송한다.
- 회의록 이름/발언을 외부 provider로 보내기 전 법적 근거, 보존, 공급자 계약 검토가 필요하다.

### 검색 품질

- 기본 vector는 **semantic embedding이 아닌 lexical feature hash**다.
- 동의어·추론 recall을 보장하지 않으며 semantic-only 후보를 찾지 못한다.
- table heuristic은 12페이지만 표시해 실제 표 recall을 알 수 없다.
- structured council 점수와 PDF hybrid 점수 분포의 calibration 평가는 아직 없다.

### 확장성·운영

- current chunk는 적정 크기로 줄었지만 version 변경 시 stale 행은 의도적으로 남는다.
  현재 DB에는 이전 released chunk 17,487개가 stale로 보존된다.
- 중간 대량 version 삭제 후 `VACUUM (ANALYZE)`는 PostgreSQL shared-memory
  `53100/no space left on device`로 실패했고 `ANALYZE`만 성공했다. 운영 DB는 여유 shared
  memory와 승인된 vacuum window가 필요하다.
- 실패 report는 200건까지만 ingestion row에 저장한다.
- page별 checkpoint 없이 전체 extraction을 다시 수행한다.

### MCP/HTTP

- PostgreSQL mode는 DB 실패 시 메모리로 조용히 fallback하지 않고 readiness를 분리한다.
- token auth, bounded rate limit/body/JSON, correlation audit, query/operation timeout은 적용됐다.
- token은 shared secret 하나이고 rate limit은 process-local이다.
- audit 만료 시각은 있지만 purge scheduler는 없다.

## 다음 우선순위

1. **P1 source lifecycle/retention:** extractor/chunker version별 승인, stale 보존기간,
   안전한 purge와 VACUUM/용량 경보를 구현한다. 현재 실측 shared-memory 실패 때문에
   OCR/semantic 확대 전에 운영 저장공간을 먼저 통제해야 한다.
2. **P1 OCR:** 승인된 로컬 OCR queue와 OCR golden/품질 점수.
3. **P1 semantic:** 검증된 multilingual local model 또는 승인된 외부 provider의 평가.
4. **P1 golden 확대:** 다른 지역·연도·다단·실제 footer·복잡 표 표본.
5. **P2 규모:** provider/dimension별 pgvector partition과 ANN index.
