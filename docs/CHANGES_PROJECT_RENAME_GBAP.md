# CHANGES: 프로젝트명을 G-BAP으로 변경, README 최신화

## 배경

프로젝트 표기가 문서마다 갈려 있었다. README 제목은 "경북 데이터 나침반"인 반면,
실제 웹 UI(`prototype/`)의 브랜드 마크는 "G : TEXFLOW"였다. 사용자 대면 이름과
문서 대면 이름이 다르면 신뢰도가 떨어지고 혼선을 준다. 이번 변경에서 두 표기를
**G-BAP**으로 통일했다.

## 변경 범위

### 브랜딩 (사용자 대면 표기만 변경, 내부 패키지명은 유지)

| 파일 | 변경 전 | 변경 후 |
| --- | --- | --- |
| `README.md` (제목) | `# 경북 데이터 나침반` | `# G-BAP (Gyeongbuk Behind-the-scenes Access Platform)` — 구 이름 병기 |
| `prototype/src/app/layout.tsx` | `G:TEXFLOW · 경북 공공데이터 브리핑` | `G-BAP · 경북 공공데이터 브리핑` |
| `prototype/src/app/guide/page.tsx` | `가이드 & FAQ · G:TEXFLOW` | `가이드 & FAQ · G-BAP` |
| `prototype/src/app/page.tsx` | `G : TEXFLOW` 배지 | `G-BAP` |
| `prototype/src/components/TurnView.tsx` | `G : TEXFLOW` 라벨 | `G-BAP` |
| `README.md` MCP stdio/HTTP 등록 예시 | `"gyeongbuk-public-ai"` 키, `/absolute/path/to/gyeongbuk-public-ai/` | `"g-bap"` 키, `/absolute/path/to/g-bap/` |

**의도적으로 바꾸지 않은 것:** 루트 `package.json`의 `name: "gyeongbuk-public-ai"`와
`@gb/*` workspace 패키지명(`@gb/mcp-server`, `@gb/pipelines`, `@gb/domain` 등),
디렉터리 구조, DB 스키마, 코드 내부 식별자. 이들은 수백 곳의 import/스크립트 경로에
얽혀 있어 브랜딩 변경만으로 손댈 실익이 없고, 잘못 바꾸면 빌드·CI가 깨질 위험이
크다. MCP 클라이언트 등록 키(`mcpServers.*`)는 사용자가 자유롭게 붙이는 라벨이라
안전하게 바꿀 수 있어 이번에 함께 정리했다.

### README에 벤치마크 근거 섹션 신설

"구현 범위" 다음에 `## 벤치마크: 근거 계층이 실제로 만드는 차이` 절을 새로 추가했다.
기존에 `benchmark/`, `benchmark/reports/`에 이미 존재하던 실측 데이터를 README
상단으로 끌어올려 정리했을 뿐, 새 벤치마크를 만들지는 않았다.

1. **Vanilla LLM vs MCP(G-BAP)** — `benchmark/reports/COMPARISON.md`의 22문항·
   3개 모델 표를 요약. 정확도 +31.8~45.5p, 답변 대비 환각률 감소, vanilla 출처
   검증 가능 비율이 전 모델 0%라는 결과를 인용.
2. **무가공 RAG vs 정규화 데이터 계층** — `benchmark/reports/raw-rag-vs-mcp-gpt-5.6-luna-gyeongbuk-v2/report.md`의
   10문항 결과를 요약 (정확도 60%→90%, 환각률 40%→14.3%, 출처 검증 가능 비율
   0%→56.3%).
3. 재현 명령(`pnpm benchmark:compare:dry-run`, `pnpm benchmark:compare`,
   `pnpm benchmark:raw-rag`)과 표본 크기·모델 순위 비교가 목적이 아니라는 주의문을
   원본 리포트에서 그대로 가져와 과장 없이 인용했다.

## 검증

- README에 인용한 세 개 리포트 파일 경로(`benchmark/README.md`,
  `benchmark/reports/COMPARISON.md`,
  `benchmark/reports/raw-rag-vs-mcp-gpt-5.6-luna-gyeongbuk-v2/report.md`)가
  실제로 존재하는지 확인했다.
- 브랜드 문자열(`G:TEXFLOW`, `G : TEXFLOW`)이 `prototype/src` 어디에도 남아있지
  않음을 grep으로 확인했다.
- 코드 로직 변경이 없어(문서·문자열만 변경) 별도 테스트 실행은 생략했다.
