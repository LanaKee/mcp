import type { Metadata } from "next";
import { PersonaProvider } from "@/components/PersonaProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "G:TEXFLOW · 경북 공공데이터 브리핑",
  description:
    "경상북도 공공데이터를 연결해 '이 정책이 나에게 해당되는가'에 답하는 MCP 에이전트 프로토타입"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-ink-950 text-[#ededed] antialiased">
        <PersonaProvider>{children}</PersonaProvider>
      </body>
    </html>
  );
}
