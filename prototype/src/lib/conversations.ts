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

/**
 * 대화를 저장한다.
 *
 * 진행 중인 턴은 **저장본에서만** 실패로 굳힌다. 새로고침 뒤에 영원히 도는
 * 스피너를 남기지 않기 위한 것이지, 지금 돌고 있는 요청에 대한 판단이 아니다.
 *
 * 그래서 저장 뒤에 알림을 보내지 않는다. 보내면 방금 질문을 보낸 화면이 자기가
 * 쓴 저장본을 되읽어, 아직 응답을 기다리는 턴을 "요청이 중단되었습니다"로
 * 덮어썼다. 실제로 `/chat`에서 후속 질문을 보낼 때마다 그렇게 됐다. 같은 탭의
 * 상태는 이미 호출부가 들고 있고, 다른 탭은 브라우저의 `storage` 이벤트로
 * 알게 된다.
 */
export function writeConversations(next: Conversation[]): void {
  if (typeof window === "undefined") return;
  try {
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
}

/** 다른 탭이 대화를 바꿨을 때만 부른다. `storage`는 쓴 탭에서는 울리지 않는다. */
export function notifyConversations(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function subscribeConversations(listener: () => void): () => void {
  // `storage`는 값을 쓴 탭에서는 울리지 않으므로, 자기가 쓴 것을 되읽는 일이
  // 없다. EVENT는 같은 탭의 다른 화면이 명시적으로 알릴 때만 쓴다.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
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
