#!/usr/bin/env node
/**
 * 화면과 MCP 서버를 함께 띄운다.
 *
 * 8787은 자기가 답하지 않는 경로를 `PROTOTYPE_ORIGIN`으로 넘긴다. 그런데
 * `pnpm start`가 MCP 서버 하나만 띄우던 동안, 배포된 서버는 아무도 없는
 * 3100으로 계속 넘기며 ECONNREFUSED만 찍었다. 넘길 곳을 만들지 않고 넘기라고만
 * 해 둔 셈이다. 두 프로세스의 수명을 여기서 묶는다.
 *
 * 환경 변수
 *   PROTOTYPE_PORT    화면이 들을 포트 (기본 3100)
 *   PROTOTYPE_ORIGIN  이미 떠 있는 화면을 쓸 때. 주면 여기서 띄우지 않는다.
 *   SKIP_PROTOTYPE=1  화면 없이 MCP 서버만.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "dev" ? "dev" : "start";

/** 자식들. 하나가 죽으면 나머지도 함께 내린다. */
const children = [];
let shuttingDown = false;

function run(name, command, args, env) {
  // pnpm은 래퍼다. 래퍼에만 SIGTERM을 보내면 실제 서버인 손자 프로세스가
  // 살아남아 포트를 쥔 채 고아가 된다. 자식을 자기 프로세스 그룹의 리더로
  // 띄우고, 내릴 때는 그룹 전체에 보낸다.
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    detached: true,
    env: { ...process.env, ...env }
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[serve] ${name} exited (code=${code} signal=${signal})`);
    shutdown(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`[serve] ${name} failed to start: ${error.message}`);
    shutdown(1);
  });
  return child;
}

function killGroup(child) {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 이미 사라진 프로세스다.
    }
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killGroup(child);
  setTimeout(() => process.exit(code), 500).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

/** 포트가 실제로 연결을 받는지. 뜨기 전에 넘기면 첫 요청이 502가 된다. */
function accepts(port, timeoutMs = 400) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (ok) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitFor(port, attempts = 150) {
  for (let i = 0; i < attempts; i += 1) {
    if (shuttingDown) return false;
    if (await accepts(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/**
 * 저장소 `.env`를 읽어 넣는다. MCP 서버는 자기가 `.env`를 읽으므로, 여기서
 * 읽지 않으면 두 프로세스가 서로 다른 `PROTOTYPE_ORIGIN`을 본다. 이미
 * 정의된 값은 덮어쓰지 않는다.
 */
function loadDotEnv() {
  let text;
  try {
    text = readFileSync(resolve(repoRoot, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/u);
    if (!match) continue;
    const key = match[1];
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/gu, "");
    if (!key || value === "" || process.env[key]) continue;
    process.env[key] = value;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

function serverArgs() {
  return ["--filter", "@gb/mcp-server", mode === "dev" ? "dev:http" : "start:http"];
}

async function main() {
  loadDotEnv();

  if (process.env.SKIP_PROTOTYPE === "1") {
    console.log("[serve] SKIP_PROTOTYPE=1 — MCP 서버만 띄운다. 화면 경로는 404다.");
    run("mcp-server", pnpm, serverArgs(), { PROTOTYPE_ORIGIN: "" });
    return;
  }

  const configured = (process.env.PROTOTYPE_ORIGIN ?? "").trim();
  let port = Number(process.env.PROTOTYPE_PORT ?? 3100);
  let externalOrigin = "";

  if (configured) {
    let url;
    try {
      url = new URL(configured);
    } catch {
      console.error(`[serve] PROTOTYPE_ORIGIN을 읽을 수 없다: ${configured}`);
      process.exit(1);
      return;
    }
    // 루프백을 가리키는 값은 "이미 떠 있다"가 아니라 "여기에 띄워라"는
    // 뜻이다. 뒤집어 읽으면 아무도 없는 포트로 넘기게 되고, 배포된 서버가
    // ECONNREFUSED만 찍는다.
    if (LOOPBACK.has(url.hostname)) {
      port = Number(url.port || 80);
    } else {
      externalOrigin = url.origin;
      console.log(`[serve] 외부 화면을 쓴다: ${externalOrigin} — 여기서 띄우지 않는다.`);
    }
  }

  const origin = externalOrigin || `http://127.0.0.1:${port}`;

  if (!externalOrigin) {
    run(
      "prototype",
      pnpm,
      ["--filter", "@gb/prototype", mode === "dev" ? "dev" : "start"],
      { PORT: String(port) }
    );
    console.log(`[serve] 화면이 뜨기를 기다린다: ${origin}`);
    if (!(await waitFor(port))) {
      console.error("[serve] 화면이 뜨지 않았다. MCP 서버를 띄우지 않는다.");
      shutdown(1);
      return;
    }
    console.log("[serve] 화면 준비됨.");
  }

  run("mcp-server", pnpm, serverArgs(), { PROTOTYPE_ORIGIN: origin });
}

main().catch((error) => {
  console.error(`[serve] ${String(error)}`);
  shutdown(1);
});
