# 데이터 파이프라인 비판적 검토

## 검토 증거

- 실제 401개 PDF, 11,712페이지를 전부 처리했다.
- 17,487 chunk, 빈 chunk 0개, 평균 834자, 최대 1,200자였다.
- content hash 중복은 82행으로, 출석자/서식 반복 등 원문 중복이 주원인이다.
- PostgreSQL 크기는 검토 시점에 chunk 약 98MB, embedding 약 36MB였다.
- 동일 1개 PDF 재실행에서 118개 embedding을 전부 skip했다.
- 초기 hybrid SQL은 전체 array scan으로 약 15초가 걸렸다. indexed candidate CTE와
  bounded cosine rerank로 같은 corpus에서 약 0.16~0.20초로 수정했다.

## 영역별 평가

### 정확성·provenance

강점:

- source SHA/path, document/chunk content hash, page locator가 연결된다.
- deterministic ID와 upsert로 같은 입력이 중복되지 않는다.
- 현재 추출에서 사라진 chunk는 삭제하지 않고 `is_current=false`로 검색에서 제외한다.
- 텍스트 없음/암호/오류를 성공처럼 취급하지 않는다.

남은 위험:

- PDF glyph 순서, 표, 다단 편집은 PDF.js reading order와 다를 수 있다.
- 날짜/기관은 파일명 추론이므로 원문 표지와 불일치할 수 있다.
- 현재 corpus는 OCR 필요 문서가 0개여서 OCR 상태 분기는 unit test와 오류 분류 위주다.

### 데이터 품질

- 문단 경계는 구두점/길이 heuristic이라 발언자 전환을 완벽하게 이해하지 못한다.
- overlap과 원문 반복 서식 때문에 일부 유사 chunk가 존재한다.
- 짧은 출석자 목록도 사실 provenance가 있어 보존하지만 검색 가중치 조정이 필요할 수 있다.

### 개인정보·비용

- 기본 provider는 로컬 결정적 계산이며 네트워크/유료 API를 사용하지 않는다.
- OpenAI는 provider 선택과 `--allow-external`, API key가 모두 있어야 전송한다.
- 회의록에는 개인 이름/발언이 있으므로 외부 provider 사용 전 법적 근거, 보존 정책,
  공급자 계약 검토가 필요하다.

### 검색 품질

- `hashed-korean-token`은 단어/2·3글자 feature hashing으로 **semantic embedding이 아니다**.
- FTS/trigram 후보를 보완하는 lexical reranker에는 유용하지만 동의어·추론 recall을
  보장하지 않는다.
- array cosine은 ANN이 아니며 lexical candidate 밖의 semantic-only 문서는 찾지 못한다.

### 확장성·운영

- 현재 17k chunk에서는 약 0.2초 검색이지만 수백만 chunk에는 적합하지 않다.
- 전체 extraction은 재실행하지만 unchanged embedding 생성은 생략한다.
- 500행 upsert와 transaction은 현 corpus에서 성공했지만 더 큰 corpus는 파일별 checkpoint와
  streaming load가 필요하다.
- 실패 report는 200건까지 저장하므로 대규모 장애는 별도 artifact/로그가 필요하다.

## 우선순위 개선

1. **P0 운영 연결:** MCP 서비스에 DB repository를 feature flag로 주입하고 접근제어/감사로그 추가.
2. **P1 품질:** 표/발언자/머리말 제거 평가셋과 page-level golden extraction test 구축.
3. **P1 OCR:** 승인된 로컬 OCR queue와 원문/추출본 품질 점수 추가.
4. **P1 semantic:** 검증된 multilingual model을 로컬 배포하거나 승인된 외부 provider 사용.
5. **P2 규모:** provider+dimension별 pgvector partition과 HNSW/IVFFlat, streaming extraction.
6. **P2 lifecycle:** source version별 retention과 stale locator 조회 정책 명문화.
