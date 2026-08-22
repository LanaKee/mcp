# MISTAKE: Raw RAG flat chunk search가 4GB heap을 소진

## 증상

Raw RAG vs MCP 10문항 실험의 첫 문항에서 Node.js가 OOM으로 종료됐다. corpus는
등록 원본 446개를 257,894개 chunk로 만들었고, 첫 API 응답 뒤 retrieval 과정에서
heap이 약 4GB에 도달했다. 실행은 리포트를 만들기 전에 실패했으므로 결과로 사용하지
않았다.

## 원인

공용 `lexicalSearch`는 각 호출마다 모든 document의 title/text를 정규화하고 중간
결과 배열을 만든다. 25만 chunk를 질문마다 flat scan하면 원문 자체보다 훨씬 큰
일시 객체가 만들어진다. intake OOM과 마찬가지로 corpus 크기보다 **비싼 작업을
후보 축소 전에 수행한 순서**가 원인이었다.

## 수정

corpus 범위나 문항은 줄이지 않고 retrieval을 두 단계로 변경했다.

1. 446개 raw file path에서 질문과 관련된 최대 20개 파일을 lexical search한다.
2. 선택된 파일의 chunk만 대상으로 최대 12개 근거를 검색한다.

이는 metadata/정규화 계층을 다시 사용하는 것이 아니라 raw RAG의 일반적인
hierarchical retrieval이다. 파일명이 불투명한 원본은 이 단계에서 검색되지 않을 수
있으며, 그 한계 자체가 현재 semantic 계층과의 비교 대상이다.
