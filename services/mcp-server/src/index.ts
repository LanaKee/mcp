import { loadDemoData } from "./data-store.js";
import { createHttpApp } from "./http.js";
import { startStdioServer } from "./mcp.js";
import { createToolRegistry } from "./tools.js";

const mode = process.argv.includes("--stdio") ? "stdio" : "http";
const store = await loadDemoData();
const registry = createToolRegistry(store);

if (mode === "stdio") {
  await startStdioServer(registry);
} else {
  const port = Number(process.env.PORT ?? 8787);
  const server = createHttpApp(registry, store);
  server.listen(port, "0.0.0.0", () => {
    console.log(`gyeongbuk-public-ai HTTP server listening on http://0.0.0.0:${port}`);
  });
}

