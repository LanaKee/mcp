"use client";

import Link from "next/link";
import { motion } from "framer-motion";

/**
 * 첫 화면.
 *
 * 여기서 아무것도 묻지 않는다. 이 서비스가 무엇인지 한 줄로 말하고 넘긴다.
 * 처음 열자마자 지역·나이·관심분야를 요구하면, 무엇을 얻게 되는지도 모르는
 * 채로 입력부터 하게 된다.
 */
export default function WelcomePage() {
  return (
    <main className="flex min-h-dvh flex-col px-6 pt-[max(2.5rem,var(--safe-t))] pb-[max(2.5rem,var(--safe-b))] sm:px-8">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="flex flex-1 flex-col items-center pt-[12vh] text-center sm:justify-center sm:pt-0"
      >
        <span className="rounded-full bg-mint-500 px-4 py-1.5 text-[12px] font-bold text-white">
          G : TEXFLOW
        </span>

        <h1 className="mt-14 text-[29px] leading-[48px] font-bold tracking-tight sm:text-[34px] sm:leading-[56px]">
          Welcome to
          <br />
          G :TEXTFLOW
        </h1>

        <p className="mt-6 max-w-[280px] text-[14px] leading-7 text-muted sm:max-w-[340px] sm:text-[15px]">
          무엇이든 물어보면 당신이 원하는
          <br />
          답을 얻을 수 있을 거예요
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.15, ease: "easeOut" }}
        className="mx-auto w-full max-w-[470px]"
      >
        <Link
          href="/intake"
          className="grid w-full place-items-center rounded-2xl bg-mint-500 py-4 text-[15px] font-bold text-white transition-colors hover:bg-mint-600"
        >
          시작하기
        </Link>
      </motion.div>
    </main>
  );
}
