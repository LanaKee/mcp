# MISTAKE: intake OOM on large/oversized inbox files

## 증상

`pnpm intake:dry-run`, `pnpm intake`이 default heap(~4GB) 위에서 다음과 함께
`FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed -
JavaScript heap out of memory`로 죽었다. `data/intake/inbox/`에 130~330MB짜리
국세청 홍보 mp4 5개와 161MB짜리 전국 단위 오피스텔 기준시가 xlsx 1개가 섞여
있는 상태에서 재현됐다.

## 근본 원인 (두 가지가 겹쳤다)

1. `pipelines/src/intake.ts`의 `planIntake`가 확장자·크기를 확인하기 전에
   `await readFile(inboxPath)`로 파일 전체를 버퍼로 읽었다. `.mp4`처럼 애초에
   `ACCEPTED_EXTENSIONS`에 없어 곧바로 quarantine될 파일도 예외 없이 전체를
   메모리에 올린 뒤에야 거부됐다. 330MB짜리 동영상 5개가 순차 루프 안에서도
   GC 압박을 유발했다.
2. `pipelines/src/catalog.ts`의 `describeDatasetFile`은 `.xlsx`면 무조건
   `populationWorkbookReferenceDate(buffer)` → `XLSX.read()`로 워크북 전체를
   파싱해 제목에서 기준일을 뽑으려 했다. 실제 인구 워크북은 4MB를 넘은 적이
   없는데, 161MB 국세청 xlsx 하나가 이 경로를 타면서 SheetJS가 파일 크기의
   수 배에 달하는 JS 객체 그래프를 만들어 heap을 밀어냈다.

## 수정

- `planIntake`에서 `stat()`으로 크기만 먼저 확인하고, 확장자가
  `ACCEPTED_EXTENSIONS`에 없거나 크기가 0이거나 `maxBytes`를 넘는 파일은
  스트리밍 해시(`hashFile`, 기존 `createReadStream` 기반)만 계산해 즉시
  quarantine한다. 버퍼 전체 로드는 실제로 파싱해야 하는 파일에만 남긴다.
- `describeDatasetFile`에 `POPULATION_WORKBOOK_PARSE_MAX_BYTES`(20MB) 상한을
  추가했다. 이보다 큰 `.xlsx`는 SheetJS 전체 파싱을 건너뛰고 파일명 기반
  `referenceDate()`로 fallback하며 `parseStatus: "catalogued"`로 표시한다.

## 검증

- `pipelines/src/intake.test.ts`(23개), `pipelines/src/xlsx.test.ts`(2개)
  통과.
- 수정 전: 130MB~332MB mp4 5개 + 161MB xlsx 1개가 섞인 inbox에서
  `pnpm intake:dry-run`이 exit 134(OOM)로 죽음.
- 수정 후: 동일 inbox에서 heap 증설 없이 정상 종료(exit 0), 268개 파일에 대한
  계획을 수 초 내에 산출.

## 교훈

검증/거부 로직은 항상 가장 저렴한 신호(파일명 확장자, `stat` 크기)부터 확인한
뒤에야 내용을 읽어야 한다. 순서가 뒤집히면 "어차피 버릴 파일"이 가장 비싼
경로를 타게 된다. 또한 파일 형식 전체를 라이브러리로 파싱해 메타데이터 하나만
뽑는 휴리스틱(제목에서 기준일 추출)은 반드시 관측된 정상 크기 범위에 대한
상한을 둬야 한다.
