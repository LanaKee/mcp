"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUp } from "@phosphor-icons/react";
import { usePersona } from "@/components/PersonaProvider";
import { personaLabel } from "@/lib/persona";
import { startConversation } from "@/lib/conversations";

const FALLBACK_SUGGESTIONS = [
  "청년 창업 지원",
  "스마트팜 조례",
  "인구 구조",
  "세수 영향"
];

export default function AskPage() {
  const router = useRouter();
  const { persona, ready } = usePersona();
  const [value, setValue] = useState("");
  const [questions, setQuestions] = useState<Array<{ id: string; question: string }>>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/questions")
      .then((response) => response.json())
      .then((body: { questions?: Array<{ id: string; question: string }> }) =>
        setQuestions(body.questions ?? [])
      )
      .catch(() => setQuestions([]));
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const placeholder = useMemo(() => {
    const region = persona.region || "우리 지역";
    const interest = persona.interest || "관심 분야";
    const age = persona.age ? `${persona.age}세인데,` : "";
    return `${region}에서 ${interest} 준비 중인 ${age}\n나한테 해당되는 게 뭐가 있어?`;
  }, [persona]);

  function submit(question: string) {
    const trimmed = question.trim();
    if (trimmed.length === 0) return;
    const conversation = startConversation(trimmed);
    router.push(`/chat?c=${conversation.id}`);
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className="w-full max-w-[640px]"
      >
        <h1 className="text-[34px] font-bold tracking-tight">무엇이 궁금한가요?</h1>
        <p className="mt-2 text-[15px] text-muted">경북의 여러 데이터를 연결해 질문에 답합니다</p>

        {ready && personaLabel(persona) ? (
          <p className="mt-3 inline-flex rounded-full border border-ink-700 bg-ink-850 px-3 py-1 text-xs text-muted">
            맥락 · {personaLabel(persona)}
          </p>
        ) : null}

        <div className="relative mt-8 rounded-3xl border border-ink-700 bg-ink-850/80 p-6 pb-16 transition-colors focus-within:border-mint-600/60">
          <textarea
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value.slice(0, 400))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(value);
              }
            }}
            rows={3}
            placeholder={placeholder}
            className="w-full resize-none bg-transparent text-[15px] leading-7 outline-none placeholder:text-[#565b63]"
          />
          <motion.button
            type="button"
            onClick={() => submit(value)}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            disabled={value.trim().length === 0}
            aria-label="질문 보내기"
            className="absolute right-5 bottom-5 grid h-10 w-10 place-items-center rounded-xl bg-mint-400 text-ink-950 transition-opacity disabled:opacity-35"
          >
            <ArrowUp size={18} strokeWidth={2.6} />
          </motion.button>
        </div>

        <p className="mt-8 text-[13px] font-semibold">추천 질문</p>
        <div className="mt-3 flex flex-wrap gap-3">
          {(questions.length > 0
            ? questions.slice(0, 6).map((item) => item.question)
            : FALLBACK_SUGGESTIONS
          ).map((question) => (
            <motion.button
              key={question}
              type="button"
              whileHover={{ y: -2 }}
              onClick={() => submit(question)}
              className="max-w-full truncate rounded-full border border-mint-600/35 bg-mint-950/60 px-5 py-2.5 text-[13px] text-mint-400/90 transition-colors hover:border-mint-500/70 hover:text-mint-400"
            >
              {question}
            </motion.button>
          ))}
        </div>
      </motion.div>
    </main>
  );
}
