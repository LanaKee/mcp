# HTTP audit correlation 스키마 변경

`db/migrations/005_http_hardening_audit.sql`을 추가했다.

## 변경

- `mcp_tool_audit.correlation_id varchar(64)` nullable 컬럼
- strict request ID 형식 check
- NULL이 아닌 correlation ID partial index

HTTP에서 허용한 inbound `X-Request-ID` 또는 생성 UUID를 도구 감사 행과 연결한다.
stdio MCP audit은 HTTP request가 아니므로 NULL일 수 있다. migration은
`ADD COLUMN IF NOT EXISTS`, constraint 존재 확인, `CREATE INDEX IF NOT EXISTS`로
재적용 가능하다.
