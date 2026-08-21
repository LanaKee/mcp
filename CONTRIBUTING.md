# 기여 안내

## 개발

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- 패키지 매니저는 pnpm만 사용합니다.
- 새 입력은 strict Zod schema로 검증합니다.
- 범용 SQL 실행 도구는 추가하지 않습니다.
- 샘플/합성 데이터에는 행과 응답 수준 모두 `demo_sample`을 표시합니다.
- 기능 변경 시 `docs/CHANGES_*.md`, DB 변경 시 `docs/DB_CHANGES_*.md`를
  갱신합니다.
- 버그나 잘못된 구현을 발견해 수정했다면 `docs/MISTAKE_*.md`에 원인과 재발 방지를
  기록합니다.
- 기능 단위 커밋과 해당 동작을 검증하는 테스트를 함께 제출합니다.

## 데이터 기여

원천 데이터는 라이선스와 개인정보를 먼저 확인하세요. 대용량 원본 대신 다운로드
방법, adapter, 소규모 재배포 가능 fixture를 선호합니다. 원본을 정규화하거나
덮어쓰지 말고 SHA-256과 provenance를 유지합니다.

## Pull Request

변경 목적, 사용한 데이터 상태, 검증 명령과 결과, 알려진 한계를 설명해 주세요.

