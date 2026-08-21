# HTTP 접근 제어와 운영 hardening

## 접근 제어

- `HTTP_AUTH_MODE=off|token`을 추가했다. local 기본은 off이고 Docker는 token을 명시한다.
- token mode는 32바이트 이상이며 placeholder/저엔트로피 token을 시작 시 거절한다.
- `/api/**`는 bearer 또는 `X-API-Key`를 SHA-256 고정 길이 digest로 constant-time
  비교한다. `/health`, 최소 `/ready`, 정적 UI는 공개다.
- stdio MCP는 local transport로 유지되어 HTTP 설정의 영향을 받지 않는다.

## 요청 경계

- socket IP별 bounded-memory token bucket을 추가하고 PDF hybrid/데모/초안에 더 낮은
  budget을 적용했다.
- `X-Forwarded-For`는 기본 무시하며 loopback 또는 최대 32개 명시 proxy IP를 설정한
  경우만 검증해 쓴다.
- POST는 JSON content type, 기본 64KiB, depth/node/array/key 제한을 적용한다.
- route/method/tool allowlist로 미등록 tool body를 파싱하지 않는다.
- CSP, nosniff, frame deny, referrer/permissions, same-origin resource 정책을 적용한다.
- wildcard CORS는 제공하지 않는다.

## 운영

- strict 또는 생성된 request ID를 응답, 일반화 오류, PostgreSQL audit에 연결한다.
- Node request/header/operation timeout과 PostgreSQL connection/statement/query timeout을
  환경변수로 제한한다.
- 401/413/415/422/429/503/504를 구분하고 오류에는 secret/raw body/내부 message를
  반환하지 않는다.
- Docker는 외부 token 주입 없이는 시작하지 않으며 TLS reverse proxy 사용을 문서화했다.
- local bind 기본은 `127.0.0.1`이고 Docker만 `0.0.0.0`을 명시한다.

## 테스트

- 강한 token 검증과 constant-time digest 비교
- bearer/API-key 성공·실패, 공개 health/readiness
- rate limit/Retry-After, spoofed proxy header
- body/content/depth, route/method/tool allowlist
- security/CORS header, correlation audit, non-sensitive backend errors
- PostgreSQL timeout config, migration, token-authenticated live smoke
