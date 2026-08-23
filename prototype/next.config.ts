import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // 컨테이너에는 저장소도 pnpm store도 없다. standalone 빌드는 실제로 쓰는
  // 모듈만 추려 자기 자신을 실행할 수 있는 한 벌로 만든다. 이미지 빌드에서만
  // 켠다 — 평소에 켜 두면 `next start`가 "does not work with output:
  // standalone"이라고 경고하며 다른 실행 경로를 권한다.
  ...(process.env.NEXT_STANDALONE === "1"
    ? { output: "standalone" as const }
    : {}),
  // 검증용 프로덕션 빌드는 별도 디렉터리에 쌓는다. 같은 .next를 쓰면 빌드가
  // 돌고 있는 dev 서버의 청크를 지워, dev 화면이 "Cannot find module
  // './999.js'"로 죽는다.
  distDir: process.env.NEXT_DIST_DIR ?? ".next"
};

export default config;
