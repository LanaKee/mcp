# 확장성: 다중 인스턴스 공유 rate-limit store (Redis)

## 배경

`docs/architecture.md`의 "후속 확장"에 `multi-instance 공용 rate-limit
store`가 미해결 과제로 적혀 있었다. 기존 `BoundedTokenBucketRateLimiter`는
프로세스 메모리에 버킷을 두므로, mcp-server를 로드밸런서 뒤에 여러 인스턴스로
띄우면 `HTTP_RATE_LIMIT_*_PER_MINUTE` 한도가 인스턴스마다 독립적으로
적용되어 실질 한도가 인스턴스 수만큼 늘어난다. 수평 확장을 하려면 상태를
공유하는 백엔드가 필요했다.

## 변경 사항

### `services/mcp-server/src/http-security.ts`

- `RateLimiter` 인터페이스를 도입해 `consume()`이 동기(in-memory) 또는
  비동기(Redis) 값을 모두 낼 수 있게 했다. `BoundedTokenBucketRateLimiter`는
  이 인터페이스를 구현하지만 시그니처는 그대로(sync) 유지해 기존 단위테스트가
  전혀 바뀌지 않는다.
- `RedisTokenBucketRateLimiter`: 단일 Lua `EVAL` 스크립트로 refill → 소비 →
  `PEXPIRE`까지 원자적으로 처리한다. 산술은 in-memory 구현과 정확히 동일하다
  (`min(limit, tokens + elapsed*refillPerMs)` 후 성공 시 1 차감). 그래서
  백엔드를 바꿔도 외부에서 관측되는 rate-limit 동작은 바뀌지 않는다. 버킷은
  `PEXPIRE idleTtlMs`로 Redis가 알아서 회수하므로 in-memory 버전의
  `rateLimitMaxBuckets`/LRU eviction에 해당하는 로직이 필요 없다.
- `createRateLimiter(config, env)`: `REDIS_URL`이 있으면 Redis 클라이언트를
  connect해 `RedisTokenBucketRateLimiter`를, 없으면 기존
  `BoundedTokenBucketRateLimiter`를 반환하고 `close()`로 정리한다.

### `services/mcp-server/src/http.ts`, `index.ts`

- `rateLimit()` 헬퍼를 `async`로 바꾸고 4곳의 호출부를 `await`하도록 수정했다
  (in-memory 구현에 대한 `await`는 동작에 영향 없음).
- `index.ts`는 부팅 시 `createRateLimiter(httpSecurity)`를 호출해 결과
  limiter를 `createHttpApp`에 주입하고, graceful shutdown 시
  `rateLimiterHandle.close()`로 Redis 연결을 정리한다.

### `docker-compose.yml`, `.env.example`

- `REDIS_URL` 환경변수 추가(기본 비어 있음 → in-memory 유지, 동작 변화 없음).
- 새 `redis` 서비스는 `profiles: ["scale"]`로 기본 `docker compose up`에는
  포함되지 않는다. mcp-server를 여러 replica로 확장할 때만
  `docker compose --profile scale up`으로 함께 띄우도록 의도했다.

### 새 테스트 — `services/mcp-server/src/redis-rate-limiter.integration.test.ts`

- `TEST_REDIS_URL`이 없으면 `*.integration.test.ts` 관례대로 self-skip한다.
- 두 개의 독립된 Redis client(서로 다른 mcp-server 인스턴스를 흉내)가 같은
  버킷 키를 공유해 한도를 정확히 지키는지, client/그룹별로 격리되는지, 시간이
  지나면 refill되는지를 검증한다.

## 검증

- 로컬에 Homebrew로 Redis를 설치해 `redis-server`를 임시 포트(6399)로 띄우고
  `RedisTokenBucketRateLimiter`를 직접 두 개의 클라이언트로 구동해 3개 한도
  버킷에서 4번째 요청이 정확히 거부되고, 61초 뒤 refill되는지 확인했다.
- 실제 `node services/mcp-server/dist/index.js --http`를 `REDIS_URL`,
  `HTTP_RATE_LIMIT_READY_PER_MINUTE=2`로 띄운 뒤 `/ready`를 3번 호출해
  1·2번째는 200, 3번째는 429가 되는 것을 확인하고 `redis-cli KEYS`로 실제
  버킷 키(`gb:ratelimit:ready:...`)가 생성됨을 확인했다.
- `pnpm --filter @gb/mcp-server typecheck`와 `pnpm test`(기존 209 unit
  테스트 전부 통과, 새 Redis 테스트는 `TEST_REDIS_URL` 없이 self-skip)로
  회귀가 없음을 확인했다.
- 사용한 임시 Postgres/Redis 인스턴스와 서버 프로세스는 모두 정리했다.

## 부수 발견: docker-compose.yml의 YAML 결함

이 작업 중 `docker-compose.yml`을 검증하려고 `js-yaml`로 파싱하다가
`DATABASE_URL: ******postgres:5432/gyeongbuk`가 애초에 유효한 YAML이
아니었다는 것을 발견해 함께 고쳤다. 자세한 내용은
`docs/MISTAKE_DOCKER_COMPOSE_YAML_ALIAS.md` 참고.

## 의도적으로 하지 않은 것

- pgvector ANN 인덱스 도입은 하지 않았다. 현재 PostgreSQL 경로는 FTS/trigram으로
  후보를 먼저 좁힌 뒤에만 cosine rerank를 하므로(architecture.md 참고) 이미
  테이블 전체 스캔은 피하고 있다. corpus가 훨씬 커지기 전에는 위험 대비 이득이
  낮다고 판단해 `architecture.md` 후속 확장 항목으로 남겨뒀다.
- DB 읽기 복제본 라우팅도 하지 않았다. 복제본이 없는 상태에서 라우팅 로직만
  추가하면 실제로 검증할 수 없고, 오배선 시 stale read 같은 새 실패 모드를
  조용히 들여올 위험이 있다고 판단했다.
