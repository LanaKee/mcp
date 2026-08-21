import { createHttpApp } from "./http.js";
import { startStdioServer } from "./mcp.js";
import { createDataRepository } from "./runtime.js";
import { createToolRegistry } from "./tools.js";

const mode = process.argv.includes("--stdio") ? "stdio" : "http";
const repository = await createDataRepository();
const registry = createToolRegistry(repository);

if (mode === "stdio") {
  const server = await startStdioServer(registry);
  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await repository.close().catch(() => undefined);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
} else {
  const port = Number(process.env.PORT ?? 8787);
  const server = createHttpApp(registry);
  const shutdown = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await repository.close().catch(() => undefined);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  server.listen(port, "0.0.0.0", () => {
    console.log(
      `gyeongbuk-public-ai HTTP server listening on http://0.0.0.0:${port} (${repository.mode})`
    );
  });
}
