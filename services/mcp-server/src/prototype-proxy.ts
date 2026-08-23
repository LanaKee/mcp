import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";

/**
 * 프로토타입 화면을 이 서버 앞에 세운다.
 *
 * 이 서버는 오랫동안 `/`에 정적 데모 한 벌을 얹어 두고 있었다. 화면은
 * 이제 Next.js로 옮겨 갔지만 그쪽은 서버 컴포넌트와 스트리밍 응답을
 * 쓰기 때문에 정적 파일로 뽑아낼 수 없다. 그래서 파일을 복사하는 대신
 * 요청을 넘긴다.
 *
 * 넘기는 것은 **이 서버가 스스로 처리하지 않는 경로뿐**이다. `/mcp`는
 * 프로토콜 종단이므로 프록시를 타지 않는다. 세션 헤더와 SSE를 중간에서
 * 다시 조립하는 순간, 잘 도는 것과 도는 척하는 것을 구분할 수 없게 된다.
 */

/** 홉 단위 헤더. 프록시 경계를 넘기면 안 된다. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export interface PrototypeProxyConfig {
  /** 프로토타입이 듣고 있는 곳. 비어 있으면 프록시하지 않는다. */
  origin: string | null;
}

export function loadPrototypeProxyConfig(
  env: NodeJS.ProcessEnv = process.env
): PrototypeProxyConfig {
  const raw = (env.PROTOTYPE_ORIGIN ?? "").trim();
  if (raw.length === 0) return { origin: null };
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:") {
      throw new Error("PROTOTYPE_ORIGIN must be an http:// origin.");
    }
    return { origin: url.origin };
  } catch (error) {
    throw new Error(
      `PROTOTYPE_ORIGIN is not a valid origin: ${raw} (${String(error)})`
    );
  }
}

/** 프로토타입이 실제로 응답하는지. 죽은 곳으로 넘기면 요청이 매달린다. */
export async function prototypeReachable(
  origin: string,
  timeoutMs = 500
): Promise<boolean> {
  const url = new URL(origin);
  const port = Number(url.port || 80);
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function forwardedHeaders(
  request: IncomingMessage,
  origin: string
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  // Next.js는 Host로 자기 자산 URL을 만든다. 원래 Host를 그대로 넘기면
  // 브라우저가 없는 주소에서 청크를 찾는다.
  headers.host = new URL(origin).host;
  const address = request.socket.remoteAddress;
  if (address) headers["x-forwarded-for"] = address;
  headers["x-forwarded-proto"] = "http";
  return headers;
}

/**
 * 요청 하나를 프로토타입으로 넘기고 응답을 그대로 돌려준다.
 *
 * 본문을 모아 두지 않고 양쪽 다 흘려보낸다. `/api/chat`은 수십 초 동안
 * SSE로 흐르는데, 여기서 버퍼에 담으면 진행 상황이 한꺼번에 도착해
 * 기다리는 동안 아무것도 보이지 않는다.
 */
export function proxyToPrototype(
  origin: string,
  request: IncomingMessage,
  response: ServerResponse,
  onFailure: (error: Error) => void
): void {
  const target = new URL(request.url ?? "/", origin);
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: target.pathname + target.search,
      headers: forwardedHeaders(request, origin)
    },
    (upstreamResponse) => {
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined) continue;
        if (HOP_BY_HOP.has(name)) continue;
        headers[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
    }
  );

  upstream.on("error", (error: Error) => onFailure(error));
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}
