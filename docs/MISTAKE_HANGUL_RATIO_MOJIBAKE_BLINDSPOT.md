# 실수 기록: 한글 비율만으로 mojibake를 통과시킨 품질 gate

## 잘못된 구현

초기 PDF 품질 gate는 공백 제외 문자 수, 한글 Unicode 범위 비율, replacement/control
glyph 비율을 주로 사용했다. Unicode `가-힣` 범위에 있다는 사실을 의미 있는 한국어의
근거처럼 취급했다.

## 발견 증거

`dojeong_2020.pdf`와 `dojeong_2022.pdf`의 깨진 CID/font mapping은
`빃켇쐚싊 붆흖칻뺂` 같은 한글 범위 음절을 만든다. 2022 전체 추출의 한글 비율은
약 0.39였지만 행정 용어 hit, curated valid bigram, 조사 token 비율은 모두 0이었다.
반면 읽을 수 있는 2021·2023·2025·2026 문서는 행정 용어 hit rate 약 0.93~0.96,
valid bigram ratio 약 0.18, 조사 비율 약 0.09~0.14였다.

따라서 이전의 “401개 PDF unusable text 0”은 기존 corpus에는 우연히 맞았지만 품질
metric 자체로는 새 CID 손상을 탐지하지 못했다.

## 원인

- 문자 encoding validity와 자연어 plausibility를 같은 것으로 봤다.
- 읽을 수 있는 positive control만 있었고 CID-corrupt negative control이 없었다.
- unusable 판정을 빈 text layer에만 연결했다.

## 수정

- 행정 용어 hit, curated Korean bigram, 조사, rare syllable composition, whitespace,
  숫자/문장부호 plausibility를 함께 점수화한다.
- 문서/페이지를 `extracted_ok`, `mojibake_suspected`,
  `unusable_for_retrieval`, `empty`로
  명시한다.
- 제외 분류는 cleaned text를 비우고 chunk/embedding/search 생성을 금지한다.
- raw text hash와 점수, page/source provenance, 제외 이유를 기록한다.
- 품질 gate는 unusable page에서 chunk가 생성되면
  severe regression으로 실패한다.

## 예방

1. readable Korean과 CID-style gibberish를 모두 unit fixture로 유지한다.
2. 새 PDF 유형은 positive/negative control로 threshold를 재보정한다.
3. Unicode script 비율만으로 “추출 성공”을 주장하지 않는다.
4. 향후 별도 extraction 방식을 도입하더라도 native text와 provenance를 구분한다.
5. Golden pass를 corpus 전체 의미 정확도의 증거로 확대 해석하지 않는다.
