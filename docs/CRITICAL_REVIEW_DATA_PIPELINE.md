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
- lifecycle migration 뒤 production approved/current chunk와 embedding은 각각 23,795,
  page locator는 11,712로 유지됐다. retained stale chunk/embedding은 각각 17,487이다.
- 최소 30일 실제 stale purge dry-run은 0건이었다. migration이 기존 stale 행에 보수적
  `stale_at`을 부여했으므로 실제 corpus는 운영자 승인 전까지 유지된다.
- controlled retired fixture는 chunk/embedding/locator/page/document-version을
  `maxRows=1`로 partial 실행 후 같은 token으로 재개해 FK-safe하게 삭제했다.
- expired audit fixture는 삭제 전 `mcp_tool_audit_daily`로 집계됐다.
- 실제 retained 17,487-chunk version으로 rollback 후 23,795-chunk production version을
  다시 승인했으며 embedding 재계산 없이 최종 가시성이 복구됐다.
- 최종 capacity는 DB 1,521,482,775 bytes, `document_chunk` 846,340,096 bytes,
  embedding 361,824,256 bytes, `source_locator` 175,742,976 bytes였다. stale ratio
  42.4% 경고가 발생했다.
- 신규 지방세 CSV 18개를 포함해 440개 파일을 다시 catalog/ETL했다. 공식 headline
  지방세 368행은 5개 지역, 29개 지역-연도를 포괄하고 demo 12행은 그대로 보존됐다.
- 이후 행정안전부 2025 지방세통계연감 HWPX(SHA-256
  `0fc7693fbbc145190b9cd09a8ddd5922892eedcaf0aa8f824ce6bf23f2617c25`)의
  2024 경상북도 표를 내용 기반으로 정규화했다. 연감 fact 176행/22개 지역 소계로
  공식 headline은 544행, 22개 시·군, 46개 지역-연도로 늘었다.
- 22개 `전체-도세=시·군세`와 22개 `시·군세 소계=세목 합계`가 모두 일치했다.
  김천 municipal CSV는 연감 시세 소계와 정확히 일치했다. 청도·봉화 CSV 합계는
  도세+군세 결합 범위임이 연감 전체 합계와 일치해 원본을 보존하되
  `headlineEligible=false`로 표시했다.
- 최종 DB에는 연감 locator 176개/지역 행 22개, 품질 info 31/warning 57/error 0이
  적재됐다. 2024 포항 공식 합계 API는 239.0ms에 440,369,434,000원과
  `statistical_yearbook_local_collection`을 반환했고 audit도 성공했다.
- 지방세 세부 grain은 징수 220, 납부매체 1,131, 과세 57, 1인당 부담 15,
  납세자 378, 비과세·감면 96, 미환급 64, 영치 통계 90행이다.
- 동일 generated artifact 재적재는 insert 0건으로 끝났고 current PDF chunk/embedding
  23,795, page 11,712, 공식 인구 221, 공식 의회 46,596을 유지했다.
- DB-backed 김천 합계 도구는 공식 수납액 107,720,311,000원을 371.4ms에 반환했고
  PDF 의회 검색은 page locator 포함 3건을 476.7ms에 반환했다. 두 호출 audit도 확인했다.
- 독립 검증에서 김천 demo 2022~2023과 공식 2024를 가로지른 허위 `-54.36%` 감소가
  발견됐다. compatibility guard 적용 뒤 동일 payload는 `summary: null`,
  `incomparable_sources`, 비교는 `evaluable: false`를 반환한다.
- 최종 token-auth PostgreSQL HTTP smoke는 trend 155.3ms, 비교 315.6ms였고 두 audit
  correlation이 성공했다. 응답 문자열에 `-54.36`은 존재하지 않았다.

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

### source lifecycle/retention

처리 version을 `candidate/approved/retired`로 분리하고 approved 하나만 허용했다.
production hybrid 검색은 approved version의 `approved_current` chunk만 읽는다. 승인과
rollback은 retained 문서 수와 embedding coverage를 확인하고 transaction에서 가시성을
전환한다.

stale/audit purge는 dry-run, exact candidate hash token, 최소 30일 보존, advisory lock,
batch/max rows/runtime, FK-safe 순서를 요구한다. audit는 일별 aggregate를 남긴다.
base document/source provenance는 삭제하지 않는다. ANALYZE-only가 기본이며 table allowlist와
timeout이 있고 VACUUM은 별도 확인이 필요하다.

실제 621MB `document_chunk`에서 120초 ANALYZE는 `57014` timeout이 발생해 기본 maintenance
상한을 10분으로 조정했고 10분 bound 안에서 성공했다. 이전 `53100` VACUUM은 자동
재시도하지 않았다.

초기 migration은 lifecycle CLI가 schema를 확인할 때 이미 올바른 current/stale 행도
다시 UPDATE해 bloat를 늘릴 수 있었다. 값이 실제로 달라지는 행만 갱신하도록 predicate를
추가했고 schema 재적용 전후 sampled current/stale chunk의 `xmin`이 유지됨을 확인했다.

### 공식 지방세 단위·grain·개인정보

호환되지 않는 원천을 `local_tax_revenue` 하나에 강제로 넣지 않고 8개 세부 fact grain으로
분리했다. headline 값은 원천 의미와 선택 근거를 별도 컬럼에 남긴다. aggregate 행은
detail 합계와 검증하고 세목 합산에서 중복 사용하지 않는다.

명시적 `(천원)`만 1,000배 변환한다. 무표기 김천 납부액은 파일명이 아니라 명시적 천원
징수자료의 주민세·재산세·자동차세·담배소비세·지방소비세·지방소득세 6개 exact match로
판정했다. 무표기 원 단위 자료는 근거가 없으면 KRW로 남긴다.

원천 blank는 0으로 만들지 않고 nullable 또는 row quarantine으로 보존한다. integer
징수율과 재계산값의 0.2~1 percentage point 차이는 publisher rounding/truncation 가능성이
높아 info로 분류하고, 1 point를 넘는 차이만 warning으로 둔다.

영천 720행은 `세액=548`, `건수=6,969,586` 같은 규모 역전이 보여도 자동 swap하지 않고
격리했다. 김천 일반건축물 40,694 data row는 주소 단위 재산 정보이므로 catalog만 남기고
fact/search/embedding에서 제외했다. 문경 영치장소도 저장하지 않았다.

행정안전부 HWPX 연감은 filename이 아니라 내부 `제4장 2024년도 ... 부과·징수실적`,
`1-16. 경상북도`, `City Tax`/`County Tax`, `단위: 천원` marker로 판별한다.
시·군세만 local headline으로 사용하며 도세가 포함된 결합 합계는 제거하지 않고
비교 제외 metadata를 남긴다. 연감 공개 metadata의 이용허락범위는 제한 없음이다.

### 혼합 series 파생 통계

point별 status label만으로는 안전하지 않았다. demo 결산 2022~2023과 공식 수납 2024를
단순 배열로 요약해 김천 `-54.36%`라는 존재하지 않는 감소 결론을 만들었다. 이제
status, accounting basis, amount semantics, source grain, source unit/multiplier 중
하나라도 다르면 전체 summary를 만들지 않는다. 인구도 status가 섞이면 같은 규칙을
적용한다.

비교 도구는 exact endpoint와 양쪽 공식 homogeneous series가 있어야 evaluable하다.
demo claim은 검증하지 않고 demo/비공식 source의 공공문서 drafting은 거절한다. 대표
demo와 UI는 공식/데모/비교불가 segment를 분리한다.

## 영역별 남은 위험

### 정확성·데이터 품질

- 2024년 공식 headline은 22개 시·군 전체를 포괄하지만 새로 보완한 17개 지역은
  대부분 단일 연도뿐이다. 한 점은 추세가 아니므로 이들 지역의 증감률/비교 verdict는
  여전히 생성할 수 없다.
- HWPX parser는 현재 연감의 경상북도 표와 aligned continuation row 구조를 검증한다.
  표 구조가 바뀌면 조용히 추정하지 않고 ETL을 실패시키지만, 인쇄 page 번호 locator는
  아직 없고 장/표/지역 행 locator만 제공한다.
- 경산·구미 1인당 부담 자료의 `지방세 금액`은 수납액과 같은 grain이 아니며
  `reported_total_tax_burden`으로 표시한다.
- 영천 quarantine은 제공기관 schema 확인 전에는 해제할 수 없다.
- 31개 zero-only 행, 과세 부분 blank 22행, 전체 blank 과세 1행은 원천 품질 신호이며
  자동 보정하지 않았다.
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
- lifecycle로 승인/보존/purge 안전장치는 생겼지만 실제 stale 17,487개는 아직 purge하지
  않았다. 논리/물리 회수량은 운영자 dry-run 승인 후에만 확인할 수 있다.
- 이전 `VACUUM (ANALYZE)`는 PostgreSQL shared-memory `53100/no space left on device`로
  실패했다. Compose는 `shm_size: 256mb` 예시를 제공하지만 운영 DB는 별도 여유 shared
  memory, disk와 승인된 vacuum window가 필요하다.
- lifecycle CLI는 scheduler가 아니다. 정기 status/audit expiry 실행과 경보 전달은 배포
  플랫폼이 구성해야 한다.
- 실제 full-version rollback/복구 integration은 약 99~140초가 걸려 요청 경로가 아니라
  maintenance window에서 수행해야 한다.
- 두 번의 full visibility UPDATE 뒤 `document_chunk` relation/index가 커졌다. retained
  rollback이 embedding 재계산은 피하지만 MVCC dead tuple/index bloat를 만들 수 있으므로
  승인 전후 용량 측정과 안전한 VACUUM window가 필요하다.
- 실패 report는 200건까지만 ingestion row에 저장한다.
- page별 checkpoint 없이 전체 extraction을 다시 수행한다.

### MCP/HTTP

- PostgreSQL mode는 DB 실패 시 메모리로 조용히 fallback하지 않고 readiness를 분리한다.
- token auth, bounded rate limit/body/JSON, correlation audit, query/operation timeout은 적용됐다.
- token은 shared secret 하나이고 rate limit은 process-local이다.
- audit expiry purge와 daily aggregate는 구현됐지만 scheduler는 배포 책임이다.

## 다음 우선순위

1. **P1 지방세 종단 coverage:** 2024 단일 점으로 끝나는 시·군의 2023 이전 동일
   시·군세 scope를 확보하고 연감 간 세목/schema drift를 평가한다. 새로 감지된
   `datasets/extra/` PDF 7개는 우선 catalog-only로 두고 구조·연도·라이선스를 검증한
   뒤에만 tax fact 후보로 사용한다.
2. **P1 OCR:** 승인된 로컬 OCR queue, OCR 전/후 provenance와 OCR golden/품질 점수.
   현재 corpus 0건 실패는 향후 scan PDF 대응을 입증하지 않는다.
3. **P1 semantic:** 검증된 multilingual local model 또는 승인된 외부 provider의 평가.
4. **P1 golden 확대:** 다른 지역·연도·다단·실제 footer·복잡 표 표본.
5. **P1 운영 자동화:** backup/restore rehearsal, lifecycle scheduler와 경보 전달.
6. **P2 규모:** provider/dimension별 pgvector partition과 ANN index.
