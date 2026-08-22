"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  BookOpen,
  ChatCircleDots,
  FolderSimple,
  Gear,
  MagnifyingGlass,
  Trash,
  UserCircle
} from "@phosphor-icons/react";
import { usePersona } from "@/components/PersonaProvider";
import { personaLabel } from "@/lib/persona";
import type { Conversation } from "@/lib/conversations";

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onClear
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const { persona } = usePersona();
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim();
    if (!needle) return conversations;
    return conversations.filter((conversation) =>
      conversation.title.includes(needle) ||
      conversation.turns.some((turn) => turn.question.includes(needle))
    );
  }, [conversations, query]);

  return (
    <aside className="flex h-screen w-[260px] shrink-0 flex-col gap-6 overflow-y-auto px-5 py-6">
      <label className="flex items-center gap-2 rounded-2xl border border-ink-700 bg-ink-850 px-3.5 py-2.5">
        <MagnifyingGlass size={15} className="text-muted" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search..."
          className="w-full bg-transparent text-[13px] outline-none placeholder:text-[#575c64]"
        />
      </label>

      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => router.push("/ask")}
          className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-[13px] text-[#d5d9de] transition-colors hover:text-white"
        >
          <ChatCircleDots size={15} className="text-muted" />
          새로 생성하기
        </button>
        <p className="flex items-center gap-2 px-1 py-1.5 text-[13px] text-muted">
          <FolderSimple size={15} />
          프로젝트
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="px-1 text-[12px] text-[#5f646c]">저장된 대화가 없습니다.</p>
        ) : (
          visible.map((conversation) => (
            <motion.button
              key={conversation.id}
              type="button"
              whileHover={{ x: 2 }}
              onClick={() => onSelect(conversation.id)}
              className={`w-full truncate rounded-xl border px-4 py-3 text-left text-[12.5px] transition-colors ${
                conversation.id === activeId
                  ? "border-mint-600/50 bg-mint-950/50 text-mint-400/90"
                  : "border-ink-700 bg-ink-850 text-[#d5d9de] hover:border-ink-600"
              }`}
            >
              {conversation.title}
            </motion.button>
          ))
        )}
      </div>

      <div className="space-y-2.5 text-[13px]">
        <Link
          href="/guide"
          className="flex items-center gap-2.5 text-[#d5d9de] transition-colors hover:text-white"
        >
          <BookOpen size={15} className="text-muted" />
          가이드 &amp; FAQ
        </Link>
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-2.5 text-[#d5d9de] transition-colors hover:text-rose-300"
        >
          <Trash size={15} className="text-muted" />
          기록 삭제하기
        </button>
        <Link
          href="/"
          className="flex items-center gap-2.5 text-[#d5d9de] transition-colors hover:text-white"
        >
          <Gear size={15} className="text-muted" />
          내 상황 다시 설정
        </Link>
      </div>

      <div className="rounded-2xl border border-ink-700 bg-ink-800 p-4">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-ink-700 text-muted">
            <UserCircle size={17} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold">
              {persona.region || "지역 미설정"}
            </p>
            <p className="truncate text-[11px] text-muted">
              {personaLabel(persona) || "맥락 없이 질문합니다"}
            </p>
          </div>
        </div>
        <p className="mt-3 text-[10.5px] leading-4 text-[#5f646c]">
          이 맥락은 브라우저 세션에만 남고 서버에 저장되지 않습니다.
        </p>
      </div>
    </aside>
  );
}
