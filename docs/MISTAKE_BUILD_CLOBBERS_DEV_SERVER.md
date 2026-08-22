# 검증용 프로덕션 빌드가 dev 서버의 청크를 지웠다

## 증상

브라우저에 Next.js 런타임 오류가 떴다.

```
Cannot find module './999.js'
Require stack:
- prototype/.next/server/webpack-runtime.js
- prototype/.next/server/pages/_document.js
```

`_document.js`는 손대지도 않은 파일이고, 소스에는 `999.js`라는 것이 없다.

## 원인

모바일 반응형을 검증하려고 `next build`를 돌리고 `next start -p 3200`으로
프로덕션 화면을 캡처했다. 그런데 **3100 포트에서 dev 서버가 계속 돌고
있었다.**

둘 다 `prototype/.next`를 쓴다. `next build`는 이 디렉터리를 새로 쌓으면서
dev 서버가 만들어 둔 청크를 지운다. dev 서버는 자기 매니페스트가 가리키는
`./999.js`를 계속 찾지만 그 파일은 이제 없다.

즉 오류 메시지에 나오는 파일들은 **원인이 아니라 피해자**다. 소스에서
`999.js`나 `_document.js`를 찾아 헤매면 아무것도 못 찾는다.

이 세션에서 이 충돌은 두 번째다. 앞서 `next build` 뒤에 `next start`를
재기동하지 않아 옛 자산 URL을 참조해 **CSS가 통째로 빠진 화면**을 캡처하고
"레이아웃이 깨졌다"고 오독할 뻔했다. 원인이 같다 — 한 디렉터리를 두 프로세스가
공유한다.

## 고친 방법

즉시 복구는 dev 서버를 멈추고 `rm -rf prototype/.next` 뒤 재기동이다.

재발을 막기 위해 **검증용 빌드의 출력 디렉터리를 분리**했다.

```ts
// next.config.ts
distDir: process.env.NEXT_DIST_DIR ?? ".next"
```

```json
"build:verify": "NEXT_DIST_DIR=.next-verify next build",
"start:verify": "NEXT_DIST_DIR=.next-verify next start --port 3200"
```

이제 프로덕션 화면을 캡처할 때 `pnpm build:verify && pnpm start:verify`를
쓰면 dev 서버가 3100에서 돌고 있어도 서로를 건드리지 않는다.
`.next-verify/`는 `.gitignore`에 넣었다.

기본값을 `.next`로 둔 것은 배포 파이프라인의 `pnpm build`가 그대로
동작해야 하기 때문이다. 분리는 **검증할 때만** 켠다.

### 알아 둘 것

`build:verify`를 돌리면 Next가 `next-env.d.ts`와 `tsconfig.json`의 타입
참조 경로를 `.next-verify` 쪽으로 다시 쓴다. 이 두 파일은 Next가 관리하는
생성물이므로 **커밋하지 말고 되돌린다.**

```
git checkout prototype/next-env.d.ts prototype/tsconfig.json
```

되돌린 뒤 `pnpm --filter @gb/prototype typecheck`가 통과하면 정상이다.

## 남는 교훈

빌드 산출물 디렉터리는 공유 자원이다. 같은 디렉터리를 쓰는 프로세스가 둘
이상이면, 한쪽의 정상 동작이 다른 쪽을 조용히 부순다. 그리고 그때 나오는
오류는 부순 쪽이 아니라 **부서진 쪽**을 가리키므로, 메시지를 따라가면
엉뚱한 곳에 도착한다.

"내가 방금 무엇을 실행했나"를 먼저 보는 편이 빠르다.
