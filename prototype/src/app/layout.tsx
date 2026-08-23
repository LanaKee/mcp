import type { Metadata, Viewport } from "next";
import { PersonaProvider } from "@/components/PersonaProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "G-BAP · 경북 공공데이터 브리핑",
  description:
    "경상북도 공공데이터를 연결해 '이 정책이 나에게 해당되는가'에 답하는 MCP 에이전트 프로토타입"
};

/**
 * 모바일에서 확대를 막지 않는다. 접근성 문제이기도 하고, 표가 들어간 카드는
 * 작은 화면에서 확대해 읽어야 할 때가 있다. 노치 영역은 페이지가 직접
 * `env(safe-area-inset-*)`로 다룬다.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-dvh bg-ink-950 text-[#ededed] antialiased">
        <PersonaProvider>{children}</PersonaProvider>
      </body>
    </html>
  );
}
