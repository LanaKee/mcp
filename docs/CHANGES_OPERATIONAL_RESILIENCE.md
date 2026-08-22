# 운영 견고성: 백업/복구, 헬스 알림, 재시작 정책

## 배경

`docs/architecture.md`의 "후속 확장"에 이미 다음이 미해결 과제로 적혀 있었다.

> - 승인된 scheduler/backup 정책과 operator-run stale purge/VACUUM window
> - lifecycle/audit purge의 외부 scheduler와 경보 전달 채널

배포가 실제로 운영 가능하려면(지속 가능성 15%) 장애/데이터 유실에서 스스로
회복하거나 최소한 사람에게 알릴 수 있어야 한다. 지금까지는 `docker-compose`에
재시작 정책도, 백업도, 알림도 없었다.

## 변경 사항

### 백업/복구 — `scripts/ops/backup.sh`, `scripts/ops/restore.sh`

- `backup.sh`: `pg_dump --format=custom --compress=9`로 압축 덤프를 만들고
  `sha256sum` 사이드카를 남긴 뒤, `BACKUP_RETENTION_DAYS`(기본 14일)보다 오래된
  덤프를 정리한다. cron/`docker-compose`/GitHub Actions 어디서든 동일하게 쓸 수
  있도록 `DATABASE_URL`/`BACKUP_DIR`/`BACKUP_RETENTION_DAYS`/`BACKUP_LABEL`
  환경변수만 필요로 한다.
- `restore.sh`: 체크섬을 먼저 검증하고 `--confirm` 플래그 없이는 절대 실행되지
  않는다. `pg_restore --clean --if-exists`로 대상 DB를 재구성한다.
- 로컬 임시 PostgreSQL 인스턴스에 스키마를 적용한 뒤 `backup.sh` →
  새 빈 데이터베이스에 `restore.sh`를 실행해 전체 테이블(`council_bill`,
  `document_chunk` 등)이 복원되는 왕복을 직접 검증했다.

### 헬스/스토리지 알림 — `scripts/ops/alert-check.sh`

- `/health`, `/ready`가 200이 아니면 문제로 기록한다.
- `ADMIN_TOKEN`이 설정되어 있으면 `/api/admin/storage`를 호출해 **HTTP 상태와
  본문을 모두** 검사한다(상태만 보지 않고 본문 `warnings` 배열도 파싱). 처음
  구현에서는 상태 코드를 확인하지 않아 503 오류 응답의 빈 JSON 바디를
  "경고 없음"으로 잘못 해석하는 결함이 있었고, 로컬에서 잘못된 토큰으로 401을
  재현해 이 버그를 확인한 뒤 상태 코드 검사를 추가해 고쳤다.
- 문제가 있으면 `ALERT_WEBHOOK_URL`(Slack/Discord 호환 incoming webhook 등
  `{"text": ...}`를 받는 아무 엔드포인트)로 POST하고 비0 종료 코드를 반환한다.
- 로컬 mock webhook 리스너로 정상/실패 두 경로 모두 end-to-end 검증했다
  (정상 시 종료 코드 0, 401 유발 시 종료 코드 1 및 webhook 수신 확인).

### `docker-compose.yml`

- `postgres`, `mcp-server`에 `restart: unless-stopped`를 추가해 컨테이너가
  죽거나 호스트가 재부팅해도 스스로 다시 뜬다.
- 새 `backup` 서비스: `postgres:16-alpine` 이미지로 `backup.sh`를 기동 시
  1회, 이후 24시간마다 반복 실행한다. 백업은 `backup-data` 볼륨에 쌓이며,
  같은 호스트의 볼륨만으로는 재해복구가 되지 않으므로 운영자가 외부로도
  복제해야 한다는 점을 주석으로 남겼다.

### `.github/workflows/production-health-alerting.yml`

- 30분마다 `scripts/ops/alert-check.sh`를 실행해 배포된 인스턴스를 폴링한다.
  `vars.PROD_SERVICE_URL`이 비어 있으면(=아직 배포 전) job 자체가 스킵되므로
  이 워크플로를 미리 머지해도 안전하다.
- `secrets.PROD_ADMIN_TOKEN`, `secrets.ALERT_WEBHOOK_URL`은 저장소 시크릿으로
  운영자가 별도 설정해야 한다.

## 의도적으로 자동화하지 않은 것

- `lifecycle:purge`/`lifecycle:audit-purge` 실행은 자동화하지 않았다.
  `architecture.md`의 신뢰 경계 16번이 exact plan token과 최소 보존기간을
  요구하도록 설계되어 있고, 이는 실수로 데이터를 지우지 못하게 하려는
  의도적 제약이다. 스케줄러가 있어도 실제 삭제는 여전히 사람이 dry-run을
  검토하고 정확한 토큰으로 승인해야 한다.
- 백업을 오브젝트 스토리지(S3 등)로 자동 업로드하지 않았다. 현재 배포 대상이
  정해지지 않아 자격 증명 스킴을 가정할 수 없다. `BACKUP_DIR`을 이미
  마운트된 원격 볼륨으로 바꾸거나, `backup.sh` 뒤에 업로드 단계를 추가하는
  방식으로 확장하도록 스크립트를 단순하게 유지했다.

## 검증

- 임시 PostgreSQL 인스턴스 3개(포트 5544/5545/5546)를 순차로 띄워 각각
  스키마 적용 → 백업/복구 왕복 → 서버 기동 후 alert-check 성공/실패 경로를
  직접 확인했다.
- 확인 후 모든 임시 인스턴스와 프로세스를 정리했다.
