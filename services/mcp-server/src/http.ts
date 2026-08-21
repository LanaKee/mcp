import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { representativeQuestions, runRepresentativeDemo } from "./demo.js";
import { executeTool, type ToolRegistry } from "./tools.js";

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("요청 본문은 1MB 이하여야 합니다.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const webCandidates = [
  resolve(moduleDirectory, "../../../apps/web/dist"),
  resolve(moduleDirectory, "../../../apps/web/src")
];

async function webDirectory() {
  for (const candidate of webCandidates) {
    try {
      await access(resolve(candidate, "index.html"));
      return candidate;
    } catch {
      // Continue to the source fallback during local development.
    }
  }
  return null;
}

export function createHttpApp(registry: ToolRegistry) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, {
          status: "ok",
          service: "gyeongbuk-public-ai",
          repository_mode: registry.repository.mode
        });
      }
      if (request.method === "GET" && url.pathname === "/ready") {
        const readiness = await registry.repository.readiness();
        return json(response, readiness.ready ? 200 : 503, {
          status: readiness.ready ? "ready" : "not_ready",
          ...readiness
        });
      }
      if (request.method === "GET" && url.pathname === "/api/questions") {
        return json(response, 200, {
          data_status:
            registry.repository.mode === "memory" ? "demo_sample" : "mixed",
          questions: representativeQuestions
        });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/tools/")) {
        const name = decodeURIComponent(url.pathname.slice("/api/tools/".length));
        return json(response, 200, await executeTool(registry, name, await body(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/demo") {
        const input = (await body(request)) as { questionId?: unknown };
        if (typeof input.questionId !== "string") {
          throw new Error("questionId 문자열이 필요합니다.");
        }
        return json(
          response,
          200,
          await runRepresentativeDemo(input.questionId, registry)
        );
      }

      if (request.method === "GET") {
        const files: Record<string, string> = {
          "/": "index.html",
          "/index.html": "index.html",
          "/app.js": "app.js",
          "/styles.css": "styles.css"
        };
        const file = files[url.pathname];
        const directory = await webDirectory();
        if (file && directory) {
          const type =
            extname(file) === ".css"
              ? "text/css; charset=utf-8"
              : extname(file) === ".js"
                ? "text/javascript; charset=utf-8"
                : "text/html; charset=utf-8";
          response.writeHead(200, { "content-type": type });
          return createReadStream(resolve(directory, file)).pipe(response);
        }
      }

      return json(response, 404, {
        data_status: registry.repository.mode === "memory" ? "demo_sample" : "mixed",
        error: "not_found"
      });
    } catch (error) {
      return json(response, 400, {
        data_status: registry.repository.mode === "memory" ? "demo_sample" : "mixed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
