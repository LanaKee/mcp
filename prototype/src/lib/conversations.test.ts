import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `conversations`는 브라우저 전역을 직접 만진다. 최소한의 가짜 window를 세워
 * 저장·구독 규칙만 검사한다.
 */
class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const listeners = new Map<string, Set<(event: unknown) => void>>();

beforeEach(() => {
  listeners.clear();
  vi.stubGlobal("window", {
    localStorage: new FakeStorage(),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: { type: string }) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    }
  });
  vi.stubGlobal("CustomEvent", class {
    constructor(readonly type: string) {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load() {
  return import("./conversations");
}

describe("대화 저장", () => {
  it("저장본에서만 진행 중인 턴을 실패로 굳힌다", async () => {
    // 새로고침 뒤 영원히 도는 스피너를 남기지 않기 위한 규칙이다. 지금 돌고
    // 있는 요청에 대한 판단이 아니므로 호출자가 넘긴 배열은 건드리지 않는다.
    const { writeConversations, readConversations } = await load();
    const pending = [
      {
        id: "c1",
        title: "질문",
        createdAt: 1,
        turns: [
          {
            id: "t1",
            question: "봉화군 인구",
            status: "pending" as const,
            reply: null,
            error: null,
            createdAt: 1
          }
        ]
      }
    ];

    writeConversations(pending);

    expect(pending[0]!.turns[0]!.status).toBe("pending");
    expect(readConversations()[0]!.turns[0]!.status).toBe("error");
  });

  it("저장이 구독자를 깨우지 않는다", async () => {
    // 깨우면 방금 질문을 보낸 화면이 자기가 쓴 저장본을 되읽어, 응답을
    // 기다리는 턴을 "요청이 중단되었습니다"로 덮어쓴다. 실제로 /chat에서
    // 후속 질문을 보낼 때마다 그렇게 됐다.
    const { writeConversations, subscribeConversations } = await load();
    const woken = vi.fn();
    subscribeConversations(woken);

    writeConversations([]);

    expect(woken).not.toHaveBeenCalled();
  });

  it("다른 탭의 변경은 구독자에게 전달한다", async () => {
    const { subscribeConversations } = await load();
    const woken = vi.fn();
    subscribeConversations(woken);

    (window as unknown as { dispatchEvent: (event: unknown) => void }).dispatchEvent({
      type: "storage",
      key: "gb.conversations"
    });

    expect(woken).toHaveBeenCalledTimes(1);
  });

  it("관계없는 키의 저장 변경은 무시한다", async () => {
    const { subscribeConversations } = await load();
    const woken = vi.fn();
    subscribeConversations(woken);

    (window as unknown as { dispatchEvent: (event: unknown) => void }).dispatchEvent({
      type: "storage",
      key: "다른-앱의-키"
    });

    expect(woken).not.toHaveBeenCalled();
  });

  it("새 대화는 진행 중 상태 그대로 저장한다", async () => {
    // /ask에서 질문을 만들고 /chat으로 넘어가면, 도착한 화면이 이 턴을 보고
    // 요청을 시작한다. 여기서 실패로 굳히면 아무 요청도 일어나지 않는다.
    const { startConversation, readConversations } = await load();

    startConversation("봉화군 인구는 어떻게 변했나?");

    expect(readConversations()[0]!.turns[0]!.status).toBe("pending");
  });
});
