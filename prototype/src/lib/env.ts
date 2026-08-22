import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 저장소 루트 `.env`를 서버 프로세스에 채운다.
 *
 * 키는 이미 루트 `.env`에 있고 파이프라인·MCP 서버가 그것을 쓴다. 프로토타입만
 * 따로 복사본을 두면 두 파일이 어긋나고, 키가 한 벌 더 디스크에 남는다.
 * 이미 정의된 값은 절대 덮어쓰지 않으므로 `prototype/.env.local`이 우선한다.
 */
let loaded = false;

export function loadRepoEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const path of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "..", ".env")]) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
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
}
