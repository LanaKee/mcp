"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { ArrowRight, MapPin, Sparkle, User } from "@phosphor-icons/react";
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
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className="w-full max-w-[470px]"
      >
        <h1 className="text-[28px] font-bold tracking-tight">먼저, 당신의 상황을 알려주세요</h1>
        <p className="mt-2 text-sm text-muted">
          정책을 검색하는 것보다 중요한 건 &lsquo;이 정책이 나에게 해당되는가?&rsquo;입니다
        </p>

        <form onSubmit={submit} className="mt-9">
          <p className="text-[13px] font-semibold">나에게 맞는 정책 브리핑을 위해 필요한 정보</p>

          <div className="mt-4 space-y-3">
            <Field
              icon={<MapPin size={14} />}
              label="지역"
              value={draft.region}
              placeholder="상주시"
              list="regions"
              onChange={(region) => setDraft({ ...draft, region })}
            />
            <Field
              icon={<User size={14} />}
              label="나이"
              value={draft.age}
              placeholder="34"
              inputMode="numeric"
              suffix="세"
              onChange={(age) => setDraft({ ...draft, age: age.replace(/[^0-9]/gu, "").slice(0, 3) })}
            />
            <Field
              icon={<Sparkle size={14} />}
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
            className="mt-10 flex w-full items-center justify-center gap-2 rounded-2xl bg-mint-400 py-4 text-[15px] font-bold text-ink-950 transition-colors hover:bg-mint-500"
          >
            맞춤 브리핑 시작하기
            <ArrowRight size={17} />
          </motion.button>
        </form>

        <p className="mt-4 text-xs text-[#5f646c]">
          개인정보를 저장하지 않고 현재 대화의 맥락으로만 활용합니다.
        </p>
      </motion.div>
    </main>
  );
}

function Field({
  icon,
  label,
  value,
  placeholder,
  onChange,
  list,
  inputMode,
  suffix
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  list?: string;
  inputMode?: "numeric" | "text";
  suffix?: string;
}) {
  return (
    <label className="flex items-center gap-4 rounded-2xl border border-ink-700 bg-ink-850 px-5 py-4 transition-colors focus-within:border-mint-600/70">
      <span className="flex w-[62px] shrink-0 items-center gap-1.5 text-[11px] text-muted">
        {icon}
        {label}
      </span>
      <span className="flex flex-1 items-baseline gap-1">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          list={list}
          inputMode={inputMode}
          className="w-full bg-transparent text-[15px] font-semibold outline-none placeholder:font-normal placeholder:text-[#4d5158]"
        />
        {suffix && value ? <span className="text-[15px] font-semibold">{suffix}</span> : null}
      </span>
    </label>
  );
}
