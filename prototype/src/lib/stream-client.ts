import type { ChatEvent } from "./chat-types";

/**
 * `/api/chat`의 서버-전송 이벤트를 읽는다.
 *
 * `EventSource`를 쓰지 않는 이유는 POST 본문(질문과 페르소나)을 실어야 하기
 * 때문이다. 프레임은 빈 줄로 끝나므로, 잘린 꼬리는 버퍼에 남겨 다음 청크와
 * 이어 붙인다.
 */
export async function readChatStream(
  body: { message: string; persona: unknown },
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `요청 실패 (HTTP ${response.status})`);
  }
  if (!response.body) throw new Error("스트리밍 응답 본문이 없습니다.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0) continue;
        try {
          onEvent(JSON.parse(payload) as ChatEvent);
        } catch {
          // 깨진 프레임은 버린다. 최종 상태는 done 이벤트가 결정한다.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
