# CHANGES — Initial Implementation

날짜: 2026-08-22

## 추가

- pnpm TypeScript workspace와 domain/retrieval/evaluation 패키지
- 재배포 가능한 `demo_sample` 데이터와 상태 전파
- 8개 목적별 MCP 도구, stdio transport, HTTP API
- 한국어 반응형 대표 질문 UI
- CP949/UTF-8 CSV, XLSX, PDF 카탈로그 ETL
- PostgreSQL schema/migration과 Docker Compose
- 도메인·검색·ETL·MCP·HTTP 자동 테스트
- 한국어 우선 실행·설계·데이터·도구 문서

## 설계 결정

- 실제 지방세·정책 원천이 없으므로 비공식 샘플을 공식 데이터와 엄격히 분리했다.
- 해커톤 실행 경로는 무DB로 재현 가능하게 하고 PostgreSQL은 정규 적재 계약으로
  제공했다.
- 외부 임베딩 없이도 실행되도록 lexical 검색을 기본으로 두고 벡터 adapter를
  인터페이스로 분리했다.
- 원본 데이터셋은 Git에서 제외하고 읽기 전용으로 처리한다.

