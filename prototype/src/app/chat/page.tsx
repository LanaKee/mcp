"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, AudioLines, Mic, Plus, Share2, SquarePen } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { TurnView } from "@/components/TurnView";
import { usePersona } from "@/components/PersonaProvider";
import {
  newId,
  readConversations,
  startConversation,
  subscribeConversations,
  titleFor,
  writeConversations,
  type Conversation
} from "@/lib/conversations";
import type { ChatReply } from "@/lib/chat-types";

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-ink-950" />}>
      <ChatScreen />
    </Suspense>
  );
}

function ChatScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const { persona } = usePersona();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const running = useRef(new Set<string>());
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // `?q=`로 들어오면 링크 하나로 질문이 시작된다. 대화는 여전히 브라우저에만 남는다.
    const asked = params.get("q");
    if (asked && asked.trim().length > 0) {
      const created = startConversation(asked.trim());
      setConversations(readConversations());
      setActiveId(created.id);
      router.replace(`/chat?c=${created.id}`);
      return subscribeConversations(() => setConversations(readConversations()));
    }
    const loaded = readConversations();
    setConversations(loaded);
    const requested = params.get("c");
    setActiveId(requested ?? loaded[0]?.id ?? null);
    return subscribeConversations(() => setConversations(readConversations()));
    // params는 첫 진입에서만 읽는다. 이후 선택은 화면 상태가 관리한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback((next: Conversation[]) => {
    setConversations(next);
    writeConversations(next);
  }, []);

  const active = conversations.find((conversation) => conversation.id === activeId) ?? null;

  /** 대기 중인 턴을 실제 요청으로 바꾼다. */
  const runTurn = useCallback(
    async (conversationId: string, turnId: string, question: string) => {
      const key = `${conversationId}:${turnId}`;
      if (running.current.has(key)) return;
      running.current.add(key);
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: question, persona })
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `요청 실패 (HTTP ${response.status})`);
        }
        const reply = (await response.json()) as ChatReply;
        setConversations((current) => {
          const next = current.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  turns: conversation.turns.map((turn) =>
                    turn.id === turnId ? { ...turn, status: "done" as const, reply } : turn
                  )
                }
              : conversation
          );
          writeConversations(next);
          return next;
        });
      } catch (error) {
        const message = (error as Error).message;
        setConversations((current) => {
          const next = current.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  turns: conversation.turns.map((turn) =>
                    turn.id === turnId
                      ? { ...turn, status: "error" as const, error: message }
                      : turn
                  )
                }
              : conversation
          );
          writeConversations(next);
          return next;
        });
      } finally {
        running.current.delete(key);
      }
    },
    [persona]
  );

  useEffect(() => {
    if (!active) return;
    for (const turn of active.turns) {
      if (turn.status === "pending") void runTurn(active.id, turn.id, turn.question);
    }
  }, [active, runTurn]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [conversations, activeId]);

  function send() {
    const question = draft.trim();
    if (question.length === 0) return;
    setDraft("");
    const turn = {
      id: newId(),
      question,
      status: "pending" as const,
      reply: null,
      error: null,
      createdAt: Date.now()
    };
    if (!active) {
      const conversation: Conversation = {
        id: newId(),
        title: titleFor(question),
        createdAt: Date.now(),
        turns: [turn]
      };
      persist([conversation, ...conversations]);
      setActiveId(conversation.id);
      return;
    }
    persist(
      conversations.map((conversation) =>
        conversation.id === active.id
          ? { ...conversation, turns: [...conversation.turns, turn] }
          : conversation
      )
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id);
          router.replace(`/chat?c=${id}`);
        }}
        onClear={() => {
          persist([]);
          setActiveId(null);
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden py-6 pr-6">
        <div className="mb-3 flex items-center justify-end gap-4 text-muted">
          <button type="button" aria-label="새 대화" onClick={() => router.push("/ask")}>
            <SquarePen size={18} />
          </button>
          <button
            type="button"
            aria-label="대화 공유"
            onClick={() => {
              if (typeof window !== "undefined") {
                void navigator.clipboard?.writeText(window.location.href);
              }
            }}
          >
            <Share2 size={18} />
          </button>
        </div>

        <section className="flex min-h-0 flex-1 flex-col rounded-3xl bg-panel/45 p-7">
          <div className="min-h-0 flex-1 space-y-10 overflow-y-auto pr-2">
            <AnimatePresence initial={false}>
              {active && active.turns.length > 0 ? (
                active.turns.map((turn) => (
                  <motion.div
                    key={turn.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="space-y-10"
                  >
                    <TurnView turn={turn} />
                  </motion.div>
                ))
              ) : (
                <motion.p
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="pt-10 text-center text-[13px] text-muted"
                >
                  아래 입력창에 지자체 데이터에 대해 물어보세요.
                </motion.p>
              )}
            </AnimatePresence>
            <div ref={bottom} />
          </div>

          <div className="relative mt-6 rounded-2xl border border-ink-700 bg-ink-850/70 px-5 pt-4 pb-12">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, 400))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="지자체 데이터에 대해 물어보세요"
              className="w-full resize-none bg-transparent text-[13.5px] leading-6 outline-none placeholder:text-[#575c64]"
            />
            <div className="absolute bottom-3.5 left-5 text-muted">
              <Plus size={17} />
            </div>
            <div className="absolute right-16 bottom-3.5 flex items-center gap-3 text-muted">
              <Mic size={16} />
              <AudioLines size={16} />
            </div>
            <motion.button
              type="button"
              onClick={send}
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.94 }}
              disabled={draft.trim().length === 0}
              aria-label="질문 보내기"
              className="absolute right-4 bottom-3 grid h-9 w-9 place-items-center rounded-full bg-mint-400 text-ink-950 transition-opacity disabled:opacity-35"
            >
              <ArrowUp size={17} strokeWidth={2.6} />
            </motion.button>
          </div>
        </section>
      </main>
    </div>
  );
}
