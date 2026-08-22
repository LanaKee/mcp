# 데이터 사용 안내

## 로컬 `datasets/`

Git에 포함하지 않는다. ETL은 원본을 복사·수정하지 않고 읽기만 하며 다음 명령으로
검사한다.

```bash
pnpm etl:dry-run
pnpm etl
```

생성 파일:

- `data/generated/catalog.json`
- `data/generated/population.normalized.json`
- `data/generated/council.normalized.json`
- `data/generated/errors.json`

각 catalog 항목은 NFC 상대경로, 파일 크기, SHA-256, 수집시각, 파일명에서 추출한
기준일, 미디어 형식, 인코딩, 내용 유형, 파싱 상태를 포함한다.

## 원천 취급 원칙

1. 원본 파일을 변경하지 않는다.
2. 원출처 URL·라이선스·수집일을 가능한 범위에서 보존한다.
3. PDF 미파싱 자료는 `catalog_only`로 표시한다.
4. 공식 파일에서 파싱한 값도 원문 locator와 함께 검토한다.
5. 공개 저장소에 추가하기 전 제공기관의 재배포 조건을 확인한다.
