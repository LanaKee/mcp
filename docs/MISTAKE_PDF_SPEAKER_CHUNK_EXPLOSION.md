# PDF 발언자 chunk 폭증 실수

## 잘못된 구현

처음에는 “발언자 경계를 넘지 않는다”를 발언자 한 turn마다 항상 별도 chunk를 만드는
것으로 구현했다. 전체 corpus에서 126,469 chunk, 중앙값 47자, 40자 미만 55,488개가
생겼다. 기존 17,487개보다 약 7.2배 많아져 embedding/인덱스 비용과 짧은 검색 결과
노이즈가 과도했다.

## 수정

- 발언 turn은 분할하지 않는 원자 segment로 유지한다.
- 한 page의 완결된 turn 여러 개를 1,200자까지 packing한다.
- max 길이 절단은 turn 사이에서만 수행하고 speaker chunk에는 이전 speaker overlap을 넣지 않는다.
- 최종 current chunk는 23,795개, 중앙값 497자, 40자 미만 2,157개가 됐다.
- streaming embedding batch를 사용해 vector 전체를 Node 메모리에 모으지 않는다.

uncommitted 중간 chunker version의 stale chunk/locator는 DB에서 제거했고 embedding은 FK
cascade로 제거했다. released 이전 version 17,487개는 요구사항대로 stale로 보존했다.

## 운영 관찰

대량 stale 삭제 뒤 PostgreSQL `VACUUM (ANALYZE)`는 shared-memory 부족
(`53100`, no space left on device)으로 실패했다. 일반 `ANALYZE`는 성공했다. 운영에서는
version retention, vacuum window, shared-memory/디스크 여유를 배포 전 확인해야 한다.
