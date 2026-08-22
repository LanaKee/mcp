# CI/CD 파이프라인 도입

## 배경

`.github/workflows`가 없어 push/PR마다 사람이 수동으로 `pnpm build` /
`pnpm typecheck` / `pnpm test`를 돌려야 했다. 평가 기준의 기술 완성도·지속
가능성 항목을 충족하려면 회귀를 자동으로 잡아내는 파이프라인이 필요하다.

## 변경 사항

### `.github/workflows/ci.yml` (push/PR, 매번 실행)

- pnpm/Node 24 설치, `pnpm install --frozen-lockfile`
- `pnpm build` → `pnpm typecheck` → `pnpm lint`(각 패키지 `tsc --noEmit`)
- 임시 Postgres 16 서비스 컨테이너에 `pnpm db:schema`만 적용해 **마이그레이션이
  깨지지 않는지**를 저비용으로 검증(스모크 체크). 실제 데이터 적재는 하지 않는다.
- `TEST_DATABASE_URL`은 설정하지 않는다 → `*.integration.test.ts`는 기존 규약대로
  self-skip하고 unit 테스트(209 passed / 40 skipped)만 빠르게 돈다.
- 이어서 `docker-build` job이 `Dockerfile`을 실제로 빌드해(push 없음) 이미지가
  항상 buildable한지 확인한다.

### `.github/workflows/full-data-integration.yml` (주간 스케줄 + 수동 실행)

- `pnpm db:normalize`(전체 ETL + PDF 추출 + hashed embedding 적재)를 실행한 뒤
  `TEST_DATABASE_URL`을 설정하고 `pnpm test`로 `*.integration.test.ts` 전체
  (예: 24,565 chunk/embedding을 검증하는 lifecycle capacity 테스트)를 돈다.
- 로컬에서 `pnpm db:normalize`를 실측한 결과 5분 타임아웃 안에 끝나지 않았다.
  PR마다 돌리기엔 너무 무거워 별도 워크플로로 분리했고, `timeout-minutes: 90`으로
  넉넉히 잡았다.

### `.github/workflows/docker-publish.yml`

- `main` push/`v*` tag에서 GHCR(`ghcr.io/<repo>`)로 이미지를 빌드·푸시한다.
  `docker/metadata-action`으로 sha/branch/semver/`latest` 태그를 자동 부여한다.

### `.github/dependabot.yml`

- npm(주간, dev-dependency 그룹핑), docker, github-actions 세 생태계를 주간으로
  갱신 PR을 낸다. 의존성 노후화로 인한 보안/유지보수 리스크를 줄인다.

## 검증

- 임시 로컬 Postgres(`initdb` + `pg_ctl`, port 5544)에 `pnpm db:schema` 적용 후
  `pnpm test` 실행 → 기존 베이스라인과 동일하게 209 passed / 40 skipped 확인.
- `pnpm db:normalize`를 같은 인스턴스에 대해 실행해 5분 내 완료되지 않음을
  확인(따라서 무거운 통합 테스트를 별도 워크플로로 분리하는 근거가 됨).
- `pnpm build` / `pnpm typecheck`는 전체 워크스페이스에서 그대로 통과.

## 의도적으로 하지 않은 것

- 매 push마다 전체 데이터 적재 + 통합 테스트를 돌리지 않는다(시간·비용 문제).
- CI에 실제 `OPENAI_API_KEY` 등 비밀을 주입하지 않는다. `db:normalize`는 기본
  hashed(feature-hash) embedding 경로만 쓰고 `--allow-external`을 켜지 않는다.
