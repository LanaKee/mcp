# 프로토타입 모바일 반응형 구현

피그마 모바일 목업(iPhone 17, 390×844)을 기준으로 기존 데스크톱 화면을
반응형으로 넓혔다. **새 라우트를 만들지 않고 같은 화면이 폭에 따라 다르게
배치되도록** 하는 방향을 택했다. 모바일 전용 화면을 따로 두면 두 벌을
계속 맞춰야 하고, 요청은 "반응형"이었다.

## 바꾼 것

### 뷰포트와 높이

- `layout.tsx`에 `export const viewport` 추가 — `width=device-width`,
  `viewportFit: "cover"` (노치 영역까지 배경을 채운다)
- 채팅 셸의 `h-screen` → `h-dvh`. iOS 사파리는 주소창이 접히고 펴지면서
  `100vh`가 실제 보이는 높이보다 커진다. 입력창이 화면 밖으로 밀려났다
- `globals.css`에 `.safe-top` / `.safe-bottom` (`env(safe-area-inset-*)`)

### 사이드바 → 서랍

`Sidebar.tsx`에서 패널 마크업 **한 벌**(`panel` 변수)을 만들어 두 컨테이너에
재사용한다.

- 데스크톱: `<aside className="hidden md:block">`
- 모바일: framer-motion `x` 슬라이드 + 백드롭 + 닫기 버튼

`open` / `onClose` prop을 받는다. 열려 있는 동안 `body` 스크롤을 잠그고,
`Escape`로 닫히고, 대화를 고르면 자동으로 닫힌다.

`chat/page.tsx` 헤더에 햄버거(`List`)와 브랜드 표시를 `md:hidden`으로 넣었다.

### 화면별 조정

- `page.tsx`(인테이크) / `ask/page.tsx` — 타이포·패딩·칩 크기 반응형
- 입력 필드를 `text-base`로. iOS는 16px 미만 입력에 포커스하면 화면을
  확대해 버리고, 그 확대가 풀리지 않는다
- `TurnView` — 말풍선 `max-w-[85%] sm:max-w-[70%]`, 아바타 축소
- `BlockList` — 카드 패딩 `p-4 sm:p-5`, 차트 `h-24 gap-1 sm:h-28 sm:gap-2`
- 표는 `w-max min-w-full` + `.scroll-x`로 **가로 스크롤**. 좁은 폭에 맞춰
  줄바꿈하면 숫자 열이 읽을 수 없게 뭉개진다
- `RoutePanel` — 헤더 truncate, 카운터는 `shrink-0`
- 스크롤바 스타일을 `@media (pointer: fine)`로 한정. 터치 기기에서 항상
  보이는 스크롤바가 내용을 가렸다

## 검증

Chrome DevTools Protocol로 `Emulation.setDeviceMetricsOverride`
(390×844, `mobile: true`, dpr 2)를 걸고 5개 화면을 캡처, 각 화면에서
`scrollWidth > clientWidth`인 요소를 전부 수집했다.

- 5개 화면 모두 `scrollWidth === 390`, 오버플로 **0건**
- 서랍 슬라이드 인 / 백드롭 / 닫기 동작 캡처 확인
- 실제 질문("봉화군 인구는 어떻게 변했나?")을 보내 **답변 카드까지** 확인.
  metricGrid, series 차트, 유의사항 카드, 출처 칩, 라우트 패널 모두 정상

발견해 고친 결함 1건: 인테이크 화면의 `관심분야` 라벨이 두 줄로 쪼개졌다
(`w-[54px]` → `w-[70px] whitespace-nowrap`).

### 캡처에서 배운 것

`chrome --screenshot --window-size=390,844`는 **모바일 에뮬레이션을 적용하지
않는다.** 레이아웃은 데스크톱 폭으로 잡히고 그 결과물을 잘라 저장하므로,
오른쪽이 잘린 것처럼 보인다. 처음에 이것을 오버플로로 오독했다. CDP로
`setDeviceMetricsOverride`를 걸어 재측정하니 오버플로는 0이었다.

`next build` 뒤에 **`next start`를 재기동하지 않으면** 실행 중인 서버가 옛
자산 URL을 참조해 CSS가 통째로 빠진다. 스타일 없는 HTML을 찍고 "레이아웃이
깨졌다"고 결론 내리기 딱 좋다.

## 함께 고친 것

검증 중에 후속 질문이 즉시 실패로 바뀌는 실제 버그를 발견해 고쳤다.
`docs/MISTAKE_SELF_NOTIFY_OVERWRITES_PENDING_TURN.md` 참고.

## 하지 않은 것

목업 1번(Welcome to G:TEXTFLOW 스플래시)은 구현하지 않았다. 요청은 기존
화면의 모바일 반응형이었고, 스플래시는 새 라우트와 진입 흐름 변경을
동반해 데스크톱까지 바뀐다. 필요하면 별도 작업으로 다룬다.
