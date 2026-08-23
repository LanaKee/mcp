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
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "dev" ? "dev" : "start";
const prototypePort = Number(process.env.PROTOTYPE_PORT ?? 3100);

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

async function main() {
  let origin = (process.env.PROTOTYPE_ORIGIN ?? "").trim();

  if (process.env.SKIP_PROTOTYPE === "1") {
    origin = "";
    console.log("[serve] SKIP_PROTOTYPE=1 — MCP 서버만 띄운다. 화면 경로는 404다.");
  } else if (origin) {
    console.log(`[serve] PROTOTYPE_ORIGIN이 이미 있다: ${origin} — 여기서 띄우지 않는다.`);
  } else {
    origin = `http://127.0.0.1:${prototypePort}`;
    run("prototype", pnpm, [
      "--filter",
      "@gb/prototype",
      mode === "dev" ? "dev" : "start"
    ]);
    console.log(`[serve] 화면이 뜨기를 기다린다: ${origin}`);
    if (!(await waitFor(prototypePort))) {
      console.error("[serve] 화면이 뜨지 않았다. MCP 서버를 띄우지 않는다.");
      shutdown(1);
      return;
    }
    console.log("[serve] 화면 준비됨.");
  }

  run(
    "mcp-server",
    pnpm,
    ["--filter", "@gb/mcp-server", mode === "dev" ? "dev:http" : "start:http"],
    { PROTOTYPE_ORIGIN: origin }
  );
}

main().catch((error) => {
  console.error(`[serve] ${String(error)}`);
  shutdown(1);
});
