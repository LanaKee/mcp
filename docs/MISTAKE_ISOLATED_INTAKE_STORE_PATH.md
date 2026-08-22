# MISTAKE: isolated intake가 기본 datasets를 수정한 경로 결합 오류

## 증상

빈 임시 PostgreSQL과 임시 raw store를 사용한 onboarding 측정에서 intake는 성공했지만
ETL이 파일 0건을 보고했다. 확인 결과 측정용 CP949 CSV가 임시 store가 아니라 저장소의
기본 `datasets/misc/`로 이동해 있었다.

## 원인

`buildStoreIndex`는 전달받은 `datasetDirectory`를 사용했지만, `reserveStorePath`는
저장 경로를 항상 `datasets/<category>/...`로 만들었다. 실행 단계도 이 경로를
`repositoryRoot`에 결합했기 때문에 custom store 옵션은 색인에만 적용되고 실제 이동에는
적용되지 않았다. 기존 테스트는 `repositoryRoot/datasets`만 사용해 이 불일치를 잡지
못했다.

## 수정

- `planIntake`에 `datasetDirectory`를 전달하고 repository root 기준 상대 경로를
  `storeRoot`로 계산한다.
- 예약 경로를 `<storeRoot>/<category>/<file>`로 생성한다.
- 기본 store 경로는 계속 `datasets/...`여서 기존 ledger와 CLI 계약은 유지한다.
- 기본 store와 다른 isolated 경로에 파일이 저장되고 기본 `datasets/`가 바뀌지 않는
  회귀 테스트를 추가한다.

첫 측정 결과는 무효 처리해 삭제했고, 기본 store로 잘못 이동한 파일도 제거한 뒤 다시
측정했다.
