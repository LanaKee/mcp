"use client";

import type { ChatTurn } from "./chat-types";

/**
 * 브라우저 안에서만 사는 대화 기록.
 *
 * 서버에는 어떤 대화도 남기지 않는다. 프로토타입의 목적은 답변 화면을 보이는
 * 것이고, 대화 저장은 그 주장에 필요하지 않으면서 개인정보만 늘린다.
 */

const KEY = "gb.conversations";
const EVENT = "gb:conversations";

export interface Conversation {
  id: string;
  title: string;
  turns: ChatTurn[];
  createdAt: number;
}

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function readConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeConversations(next: Conversation[]): void {
  if (typeof window === "undefined") return;
  try {
    // 진행 중 표시로 남은 턴은 새로고침 뒤에 영원히 도는 것처럼 보이므로 실패로 굳힌다.
    const settled = next.map((conversation) => ({
      ...conversation,
      turns: conversation.turns.map((turn) =>
        turn.status === "pending"
          ? { ...turn, status: "error" as const, error: "요청이 중단되었습니다." }
          : turn
      )
    }));
    window.localStorage.setItem(KEY, JSON.stringify(settled.slice(0, 30)));
  } catch {
    // 용량 초과 등은 무시한다. 화면 상태는 메모리에 남아 있다.
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function subscribeConversations(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function titleFor(question: string): string {
  const trimmed = question.replace(/^\[[^\]]*\]\s*/u, "").trim();
  return trimmed.length > 22 ? `${trimmed.slice(0, 22)}…` : trimmed || "새 대화";
}

/** 첫 질문과 함께 대화를 만든다. `/ask`에서 호출하고 `/chat`이 이어받는다. */
export function startConversation(question: string): Conversation {
  const conversation: Conversation = {
    id: newId(),
    title: titleFor(question),
    createdAt: Date.now(),
    turns: [
      {
        id: newId(),
        question,
        status: "pending",
        reply: null,
        error: null,
        createdAt: Date.now()
      }
    ]
  };
  const existing = readConversations();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        KEY,
        JSON.stringify([conversation, ...existing].slice(0, 30))
      );
    } catch {
      // 무시
    }
  }
  return conversation;
}
