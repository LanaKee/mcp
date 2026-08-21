# MCP repository와 감사 스키마 변경

`db/migrations/004_mcp_repository_audit.sql`을 추가했다.

## `mcp_tool_audit`

- 도구명, 시작/종료/지연, 성공, 실제 data status, 결과 수를 저장한다.
- 요청 본문 대신 64자리 salted SHA-256과 필드 타입/길이 metadata를 저장한다.
- 일반 오류 class와 repository mode를 저장하며 raw 검색어/secret은 저장하지 않는다.
- 기본 만료 시각은 생성 후 90일이다.
- 생성 시각, 도구+시각, 만료 시각 인덱스를 제공한다.
- audit write는 best-effort이며 읽기 성공 여부와 분리한다.

운영 환경은 다음과 같이 주기 삭제해야 한다.

```sql
DELETE FROM mcp_tool_audit WHERE expires_at < now();
```

## 검색 인덱스

PostgreSQL 의회 repository의 bounded FTS 검색을 위해 `council_record.title`의
`to_tsvector('simple', title)` GIN 인덱스를 추가했다. 현재 schema와 migration은
`CREATE INDEX IF NOT EXISTS`로 재적용 가능하다.
