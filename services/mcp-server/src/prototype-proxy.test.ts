import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { loadDemoData } from "./data-store.js";
import { createHttpApp } from "./http.js";
import { loadHttpSecurityConfig } from "./http-security.js";
import { InMemoryDataRepository } from "./repository.js";
import { createToolRegistry } from "./tools.js";
import {
  loadPrototypeProxyConfig,
  prototypeReachable,
  proxyToPrototype
} from "./prototype-proxy.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("주소를 얻지 못했습니다.");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("loadPrototypeProxyConfig", () => {
  it("비어 있으면 프록시하지 않는다", () => {
    expect(loadPrototypeProxyConfig({} as NodeJS.ProcessEnv).origin).toBeNull();
    expect(
      loadPrototypeProxyConfig({ PROTOTYPE_ORIGIN: "  " } as NodeJS.ProcessEnv)
        .origin
    ).toBeNull();
  });

  it("경로가 붙어 있어도 오리진만 남긴다", () => {
    const config = loadPrototypeProxyConfig({
      PROTOTYPE_ORIGIN: "http://127.0.0.1:3100/chat"
    } as NodeJS.ProcessEnv);
    expect(config.origin).toBe("http://127.0.0.1:3100");
  });

  it("주소가 아니면 조용히 넘어가지 않는다", () => {
    // 잘못 적은 값을 null로 흘려보내면 화면이 통째로 404가 되고,
    // 원인은 설정이 아니라 서버 코드에 있는 것처럼 보인다.
    expect(() =>
      loadPrototypeProxyConfig({ PROTOTYPE_ORIGIN: "3100" } as NodeJS.ProcessEnv)
    ).toThrow(/not a valid origin/u);
  });
});

describe("prototypeReachable", () => {
  it("듣고 있으면 참", async () => {
    const origin = await listen(createServer((_request, response) => response.end("ok")));
    expect(await prototypeReachable(origin)).toBe(true);
  });

  it("아무도 없으면 거짓", async () => {
    // 포트를 열었다가 바로 닫아, 아무도 듣지 않는 주소를 확실히 만든다.
    const server = createServer();
    const origin = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    expect(await prototypeReachable(origin, 200)).toBe(false);
  });
});

describe("proxyToPrototype", () => {
  it("메서드와 본문과 상태를 그대로 옮긴다", async () => {
    const seen: { method?: string; url?: string; body: string } = { body: "" };
    const upstream = await listen(
      createServer((request, response) => {
        seen.method = request.method;
        seen.url = request.url;
        request.on("data", (chunk: Buffer) => {
          seen.body += chunk.toString("utf8");
        });
        request.on("end", () => {
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        });
      })
    );

    const front = await listen(
      createServer((request, response) => {
        proxyToPrototype(upstream, request, response, () => {
          response.writeHead(502);
          response.end();
        });
      })
    );

    const result = await fetch(`${front}/api/chat?x=1`, {
      method: "POST",
      body: JSON.stringify({ question: "봉화군 인구" })
    });

    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({ ok: true });
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/api/chat?x=1");
    expect(seen.body).toBe(JSON.stringify({ question: "봉화군 인구" }));
  });

  it("Host를 프로토타입 것으로 바꿔 보낸다", async () => {
    // Next.js는 Host로 자기 자산 URL을 만든다. 원래 Host를 그대로 넘기면
    // 브라우저가 없는 주소에서 청크를 찾고, 화면은 스타일 없이 뜬다.
    let host = "";
    const upstream = await listen(
      createServer((request, response) => {
        host = request.headers.host ?? "";
        response.end("ok");
      })
    );
    const front = await listen(
      createServer((request, response) => {
        proxyToPrototype(upstream, request, response, () => response.end());
      })
    );

    await fetch(`${front}/`);

    expect(host).toBe(new URL(upstream).host);
  });

  it("응답을 모아 두지 않고 도착하는 대로 흘려보낸다", async () => {
    // /api/chat은 수십 초 동안 SSE로 흐른다. 여기서 버퍼에 담으면 진행
    // 상황이 한꺼번에 도착해, 기다리는 동안 화면에 아무것도 나오지 않는다.
    const upstream = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        setTimeout(() => {
          response.write("data: second\n\n");
          response.end();
        }, 150);
      })
    );
    const front = await listen(
      createServer((request, response) => {
        proxyToPrototype(upstream, request, response, () => response.end());
      })
    );

    const result = await fetch(`${front}/api/chat`);
    const reader = result.body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);

    expect(firstChunk).toContain("first");
    expect(firstChunk).not.toContain("second");
    await reader.cancel();
  });

  it("프로토타입이 죽어 있으면 실패를 알린다", async () => {
    const dead = createServer();
    const origin = await listen(dead);
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    servers.splice(servers.indexOf(dead), 1);

    const front = await listen(
      createServer((request, response) => {
        proxyToPrototype(origin, request, response, () => {
          response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "prototype_unavailable" }));
        });
      })
    );

    const result = await fetch(`${front}/`);
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: "prototype_unavailable" });
  });
});

describe("createHttpApp와 프록시", () => {
  it("token 모드에서 화면을 얹으려 하면 시작하지 않는다", async () => {
    const store = await loadDemoData();
    const registry = createToolRegistry(new InMemoryDataRepository(store));
    const security = loadHttpSecurityConfig({
      HTTP_AUTH_MODE: "token",
      HTTP_AUTH_TOKEN: "0123456789abcdefABCDEF-ghijklmnopqrstuvwxyz_9876543210"
    });

    expect(() =>
      createHttpApp(registry, { security, prototypeOrigin: "http://127.0.0.1:3100" })
    ).toThrow("HTTP_AUTH_MODE=token");
  });

  it("화면 경로가 없으면 프록시를 걸지 않고도 시작한다", async () => {
    const store = await loadDemoData();
    const registry = createToolRegistry(new InMemoryDataRepository(store));
    const security = loadHttpSecurityConfig({
      HTTP_AUTH_MODE: "token",
      HTTP_AUTH_TOKEN: "0123456789abcdefABCDEF-ghijklmnopqrstuvwxyz_9876543210"
    });

    expect(() =>
      createHttpApp(registry, { security, prototypeOrigin: null })
    ).not.toThrow();
  });
});
