import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // 검증용 프로덕션 빌드는 별도 디렉터리에 쌓는다. 같은 .next를 쓰면 빌드가
  // 돌고 있는 dev 서버의 청크를 지워, dev 화면이 "Cannot find module
  // './999.js'"로 죽는다.
  distDir: process.env.NEXT_DIST_DIR ?? ".next"
};

export default config;
