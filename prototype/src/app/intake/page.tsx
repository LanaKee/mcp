"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { usePersona } from "@/components/PersonaProvider";
import type { Persona } from "@/lib/persona";

const REGIONS = ["상주시", "포항시", "안동시", "구미시", "경주시", "울진군", "경상북도"];
const INTERESTS = ["스마트팜 · 창업", "청년 정책", "인구 · 세수", "의정활동", "보도자료"];

export default function IntakePage() {
  const router = useRouter();
  const { persona, setPersona } = usePersona();
  const [draft, setDraft] = useState<Persona>(persona);

  function submit(event: FormEvent) {
    event.preventDefault();
    setPersona(draft);
    router.push("/ask");
  }

  return (
    // 좁은 화면에서 세로 가운데 정렬을 하면 키보드가 올라올 때 제목이 위로
    // 밀려 사라진다. 모바일은 위에서부터 쌓고, 넓은 화면에서만 가운데로 둔다.
    <main className="flex min-h-dvh justify-center px-5 pt-[max(3rem,var(--safe-t))] pb-[max(3rem,var(--safe-b))] sm:items-center sm:px-6 sm:pt-[max(4rem,var(--safe-t))] sm:pb-[max(4rem,var(--safe-b))]">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className="w-full max-w-[470px]"
      >
        <h1 className="text-[20px] font-bold tracking-tight sm:text-[28px]">먼저, 당신의 상황을 알려주세요</h1>
        <p className="mt-2 max-w-[285px] text-[12.5px] leading-5 text-muted sm:max-w-none sm:text-sm sm:leading-6">
          정책을 검색하는 것보다 중요한 건 &lsquo;이 정책이 나에게 해당되는가?&rsquo;입니다
        </p>

        <form onSubmit={submit} className="mt-7 sm:mt-9">
          <div className="space-y-3">
            <Field
              label="지역"
              value={draft.region}
              placeholder="상주시"
              list="regions"
              onChange={(region) => setDraft({ ...draft, region })}
            />
            <Field
              label="나이"
              value={draft.age}
              placeholder="34"
              inputMode="numeric"
              suffix="세"
              onChange={(age) => setDraft({ ...draft, age: age.replace(/[^0-9]/gu, "").slice(0, 3) })}
            />
            <Field
              label="관심분야"
              value={draft.interest}
              placeholder="스마트팜 · 창업"
              list="interests"
              onChange={(interest) => setDraft({ ...draft, interest })}
            />
          </div>

          <datalist id="regions">
            {REGIONS.map((region) => (
              <option key={region} value={region} />
            ))}
          </datalist>
          <datalist id="interests">
            {INTERESTS.map((interest) => (
              <option key={interest} value={interest} />
            ))}
          </datalist>

          <motion.button
            type="submit"
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.985 }}
            className="mt-6 grid w-full place-items-center rounded-2xl bg-mint-500 py-4 text-[15px] font-bold text-white transition-colors hover:bg-mint-600 sm:mt-8"
          >
            맞춤 브리핑 시작하기
          </motion.button>
        </form>

        <p className="mt-3.5 text-[11.5px] leading-4 text-[#5f646c] sm:text-xs">
          개인정보를 저장하지 않고 현재 대화의 맥락으로만 활용합니다.
        </p>
      </motion.div>
    </main>
  );
}

function Field({
  label,
  value,
  placeholder,
  onChange,
  list,
  inputMode,
  suffix
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  list?: string;
  inputMode?: "numeric" | "text";
  suffix?: string;
}) {
  return (
    <label className="flex items-center gap-3 rounded-2xl border border-ink-700 bg-ink-850 px-4 py-3 transition-colors focus-within:border-mint-600/70 sm:gap-4 sm:px-5 sm:py-3.5">
      <span className="shrink-0 text-[11.5px] whitespace-nowrap text-muted">{label}</span>
      <span className="flex flex-1 items-baseline gap-1">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          list={list}
          inputMode={inputMode}
          className="w-full bg-transparent text-base font-semibold outline-none placeholder:font-normal placeholder:text-[#4d5158]"
        />
        {suffix && value ? <span className="text-[15px] font-semibold">{suffix}</span> : null}
      </span>
    </label>
  );
}
