# 실수(발견): docker-compose.yml의 DATABASE_URL이 유효하지 않은 YAML이었음

## 무엇이 잘못됐나

`docker-compose.yml`의 `backup`/`mcp-server` 두 서비스 모두
`DATABASE_URL: ******postgres:5432/gyeongbuk` 형태의 값을 그대로 갖고 있었다.
YAML에서 스칼라 값이 인용부호 없이 `*`로 시작하면 **별칭(alias) 참조**로
해석된다. 이 파일에는 `******postgres:5432/gyeongbuk`이라는 앵커가 정의된 적이
없으므로, `docker compose`/`js-yaml` 등 표준 YAML 파서는 이 파일을 아예
파싱하지 못하고 `unidentified alias` 오류로 실패한다. 즉 이 프로젝트의
`docker-compose.yml`은 이번 작업 이전부터 **한 번도 실제로 파싱 가능한 상태가
아니었을 가능성이 높다**(로컬에 `docker`가 없어 이번 세션 전까지 실제
`docker compose config`로 검증된 적이 없었던 것으로 보인다).

## 어떻게 발견했나

Redis 기반 rate limiter를 위해 `docker-compose.yml`에 `redis` 서비스와
`REDIS_URL` 환경변수를 추가한 뒤, 변경분이 유효한지 확인하려고
`npx js-yaml docker-compose.yml`로 파싱을 시도했다. 그 결과
`YAMLException: unidentified alias "*****postgres:5432/gyeongbuk" (29:22)`가
나서 기존 값이 원래부터 깨져 있었음을 확인했다.

부수적으로, 이 프로젝트의 CLI 도구 자체가 `postgres://user:pass@host` 형태의
자격증명처럼 보이는 문자열을 **터미널 출력에 보여줄 때** `******`로 마스킹한다는
것도 함께 알게 됐다. 처음에는 이 마스킹을 "내 수정이 파일에 반영되지 않고
있다"는 신호로 오해해 같은 치환을 여러 번 반복 시도했다. `js-yaml`로 실제
디스크 내용을 파싱해 성공(exit 0)한 뒤에야, 파일은 이미 올바르게 고쳐졌고
단지 터미널에 보여지는 텍스트만 마스킹되고 있었다는 것을 확인했다.

## 수정

두 `DATABASE_URL` 값을 `postgres://gyeongbuk:gyeongbuk@postgres:5432/gyeongbuk`
(compose 파일에 이미 평문으로 선언된 `postgres` 서비스의 자격증명과 동일)로
교체했다. `npx js-yaml docker-compose.yml`로 파일 전체가 유효한 YAML로
파싱되고, `mcp-server`/`backup` 두 서비스의 `DATABASE_URL`이 `postgres://`로
시작하는지 JSON으로 역직렬화해 확인했다.

## 교훈

1. YAML에서 인용부호 없는 스칼라가 `*`로 시작하면 항상 별칭으로 해석된다.
   자격증명이나 임의 문자열을 compose/YAML 값으로 넣을 때는 특히 `*`, `&`,
   `!`, `|`, `>`로 시작하는 값을 인용부호로 감싸야 한다.
2. `docker`가 없는 환경에서 `docker-compose.yml`을 수정할 때는
   `npx js-yaml <file>` 같은 독립 파서로라도 파싱 가능성을 검증해야 한다.
   들여쓰기가 보기에 맞다고 해서 유효한 YAML이라는 보장은 없다.
3. 자격증명처럼 보이는 문자열이 터미널에 마스킹되어 보일 수 있다는 점을
   인지하고, 텍스트가 "그대로인 것처럼 보인다"고 해서 실제 파일 내용이
   바뀌지 않았다고 성급히 결론 내리지 않는다. 실제 파일 상태는 파서/해시
   비교처럼 마스킹의 영향을 받지 않는 방법으로 확인해야 한다.
