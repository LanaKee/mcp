"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  List,
  Microphone,
  PencilSimple,
  Plus,
  ShareNetwork,
  Waveform
} from "@phosphor-icons/react";
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
import { readChatStream } from "@/lib/stream-client";
import type { ChatTurn, StageEvent } from "@/lib/chat-types";
import type { Block } from "@/lib/blocks";

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-ink-950" />}>
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
  const [menuOpen, setMenuOpen] = useState(false);
  const running = useRef(new Set<string>());
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // 한 줄로 시작해 내용만큼만 늘어난다. 고정 높이를 두면 좁은 화면에서
  // 쓰지도 않는 두 번째 줄이 대화 영역을 계속 갉아먹는다.
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 128)}px`;
  }, [draft]);

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

  /**
   * 대기 중인 턴을 실제 요청으로 바꾼다.
   *
   * 응답은 스트림이므로 도착하는 대로 화면을 고친다. 진행 상태는 저장하지
   * 않는다. 새로고침 후에 남은 반쪽짜리 추론 과정은 아무 의미가 없고, 완료된
   * 답만이 다시 열어 볼 가치가 있다.
   */
  const runTurn = useCallback(
    async (conversationId: string, turnId: string, question: string) => {
      const key = `${conversationId}:${turnId}`;
      if (running.current.has(key)) return;
      running.current.add(key);

      const patch = (mutate: (turn: ChatTurn) => ChatTurn, save: boolean) => {
        setConversations((current) => {
          const next = current.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  turns: conversation.turns.map((turn) =>
                    turn.id === turnId ? mutate(turn) : turn
                  )
                }
              : conversation
          );
          if (save) writeConversations(next);
          return next;
        });
      };

      const progress = {
        stages: [] as StageEvent[],
        tools: [] as Array<{ tool: string; datasetId: string; reason: string }>,
        reasoning: "",
        summary: null as string | null,
        blocks: [] as Block[]
      };
      const pushProgress = () => patch((turn) => ({ ...turn, progress: { ...progress } }), false);

      try {
        await readChatStream({ message: question, persona }, (event) => {
          switch (event.type) {
            case "stage": {
              // 같은 단계가 running에서 done으로 바뀌면 줄을 늘리지 않고 갈아 끼운다.
              const index = progress.stages.findIndex((stage) => stage.id === event.stage.id);
              if (index >= 0) progress.stages[index] = event.stage;
              else progress.stages.push(event.stage);
              pushProgress();
              break;
            }
            case "tool":
              progress.tools.push({
                tool: event.tool,
                datasetId: event.datasetId,
                reason: event.reason
              });
              pushProgress();
              break;
            case "reasoning":
              // 추론 요약은 토큰 단위로 오므로 이어 붙인다. 화면은 꼬리만 보여준다.
              progress.reasoning += event.delta;
              pushProgress();
              break;
            case "summary":
              progress.summary = event.summary;
              pushProgress();
              break;
            case "block":
              progress.blocks.push(event.block);
              pushProgress();
              break;
            case "done":
              patch(
                (turn) => ({
                  ...turn,
                  status: "done" as const,
                  reply: event.reply,
                  progress: undefined
                }),
                true
              );
              break;
            case "error":
              throw new Error(event.message);
          }
        });
      } catch (error) {
        const message = (error as Error).message;
        patch(
          (turn) => ({ ...turn, status: "error" as const, error: message, progress: undefined }),
          true
        );
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
    // h-screen은 모바일 브라우저 주소창이 접힐 때 실제 화면보다 커져서 입력창을
    // 화면 밖으로 밀어낸다. dvh는 그 변화를 따라간다.
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSelect={(id) => {
          setActiveId(id);
          router.replace(`/chat?c=${id}`);
        }}
        onClear={() => {
          persist([]);
          setActiveId(null);
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden px-3 pt-[max(0.75rem,var(--safe-t))] pb-3 md:pt-6 md:pb-6 md:pr-6 md:pl-0">
        <div className="mb-3 flex items-center gap-4 text-muted">
          <button
            type="button"
            aria-label="메뉴 열기"
            onClick={() => setMenuOpen(true)}
            className="md:hidden"
          >
            <List size={20} />
          </button>
          <button
            type="button"
            aria-label="새 대화"
            className="ml-auto hidden md:block"
            onClick={() => router.push("/ask")}
          >
            <PencilSimple size={18} />
          </button>
          <button
            type="button"
            aria-label="대화 공유"
            className="hidden md:block"
            onClick={() => {
              if (typeof window !== "undefined") {
                void navigator.clipboard?.writeText(window.location.href);
              }
            }}
          >
            <ShareNetwork size={18} />
          </button>
        </div>

        <section className="flex min-h-0 flex-1 flex-col pb-[max(0.75rem,var(--safe-b))] md:rounded-3xl md:bg-panel/45 md:p-7">
          <div className="min-h-0 flex-1 space-y-8 overflow-y-auto md:space-y-10 md:pr-2">
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

          {/* 목업의 입력 바는 알약 하나에 +, 입력, 마이크, 녹음이 한 줄로 놓인다.
              여러 줄을 쓰는 경우는 드물어서, 필요할 때만 높이가 늘어난다. */}
          <div className="mt-4 flex items-end gap-2 rounded-3xl border border-ink-700 bg-ink-850/70 px-3 py-2.5 transition-colors focus-within:border-mint-600/50 md:mt-6 md:gap-3 md:px-4 md:py-3">
            <button
              type="button"
              aria-label="첨부"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:text-white"
            >
              <Plus size={18} />
            </button>

            <textarea
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, 400))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="지자체 데이터에 대해 물어보세요"
              className="max-h-32 min-h-[36px] flex-1 resize-none self-center bg-transparent py-2 text-[13.5px] leading-5 outline-none placeholder:text-[#575c64]"
            />

            <button
              type="button"
              aria-label="음성 입력"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:text-white"
            >
              <Microphone size={17} />
            </button>

            {/* 보낼 것이 있으면 화살표, 없으면 목업처럼 녹음 버튼을 둔다.
                같은 자리에서 모양만 바뀌므로 누를 곳을 다시 찾지 않아도 된다. */}
            <motion.button
              type="button"
              onClick={send}
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.94 }}
              aria-label={draft.trim().length === 0 ? "음성으로 질문하기" : "질문 보내기"}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-mint-400 text-ink-950"
            >
              {draft.trim().length === 0 ? (
                <Waveform size={17} weight="bold" />
              ) : (
                <ArrowUp size={17} strokeWidth={2.6} />
              )}
            </motion.button>
          </div>
        </section>
      </main>
    </div>
  );
}
