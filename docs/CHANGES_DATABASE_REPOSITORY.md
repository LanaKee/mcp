# PostgreSQL 실행 repository 연결

## 변경

- 인구, 지방세, 정책, 의회, PDF hybrid 검색, 출처 context, 주장 검증 repository 계약을
  추가하고 기존 데모 저장소를 메모리 구현으로 유지했다.
- `DATA_REPOSITORY=auto|postgres|memory|disabled` runtime factory를 추가했다.
- PostgreSQL 구현은 목적별 parameterized/bounded query만 제공하며 동일 키에서는
  `official_observed`를 우선한다.
- factual tool 입력에 선택 `dataStatuses`를 추가하고 혼합 응답은 `mixed`와 상태 배열로
  표시한다.
- HTTP와 stdio가 같은 repository를 주입하고 `/health`와 `/ready`를 분리했다.
- SIGINT/SIGTERM에서 MCP/HTTP와 PostgreSQL pool을 닫는다.
- 의회 검색에 구조화 레코드와 PDF chunk hybrid 결과를 연결하고 page/source context를
  반환한다.
- 도구 호출은 raw 입력 대신 salted hash와 redacted shape로 PostgreSQL audit에 기록한다.

## 검증

- fake repository 주입, 상태 전달, audit failure 격리 unit test
- PostgreSQL parameterization/limit/audit contract test
- `TEST_DATABASE_URL`이 있을 때만 실행하는 facts/PDF integration test
- 실제 DB smoke: ready, 인구, 지방세, 비교, 정책, 의회/PDF, source page context 확인
- audit 19건 이상에서 raw 검색어 metadata 저장 0건 확인
