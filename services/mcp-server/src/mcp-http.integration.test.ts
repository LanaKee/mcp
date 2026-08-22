import type { AddressInfo } from "node:net";
import { Client as PgClient } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpApp } from "./http.js";
import { loadMcpHttpConfig, McpSessionManager } from "./mcp-http.js";
import { PostgresDataRepository } from "./postgres-repository.js";
import { createToolRegistry } from "./tools.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;

let repository: PostgresDataRepository | undefined;
let server: ReturnType<typeof createHttpApp> | undefined;
let sessions: McpSessionManager | undefined;
let endpoint = "";

beforeAll(async () => {
  if (!connectionString) return;
  repository = PostgresDataRepository.fromConnectionString(connectionString);
  sessions = new McpSessionManager(loadMcpHttpConfig({}));
  server = createHttpApp(createToolRegistry(repository), {
    mcpSessions: sessions
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${
    (server.address() as AddressInfo).port
  }/mcp`;
});

afterAll(async () => {
  await sessions?.closeAll();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await repository?.close();
});

async function connect(): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client({ name: "integration", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  await client.connect(transport);
  return { client, transport };
}

describeDatabase("hosted MCP endpoint against PostgreSQL", () => {
  it("returns observed data with structured content over HTTP", async () => {
    const { client, transport } = await connect();
    const result = await client.callTool({
      name: "get_population_trend",
      arguments: { region: "청도군", startYear: 2024, endYear: 2026 }
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.data_status).toBe("official_observed");
    const text = (result.content as { text: string }[])[0].text;
    expect(JSON.parse(text)).toMatchObject({
      data_status: structured.data_status
    });
    await transport.terminateSession();
    await client.close();
  });

  it("records a conforming correlation id in the tool audit log", async () => {
    const { client, transport } = await connect();
    const sessionId = transport.sessionId!;
    await client.callTool({
      name: "get_population_trend",
      arguments: { region: "청도군", startYear: 2024, endYear: 2026 }
    });
    const scope = `mcp-${sessionId.replace(/[^A-Za-z0-9._-]/g, "")}%`;
    const pg = new PgClient({ connectionString });
    await pg.connect();
    try {
      const { rows } = await pg.query<{ correlation_id: string }>(
        "SELECT correlation_id FROM mcp_tool_audit WHERE correlation_id LIKE $1",
        [scope]
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.correlation_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/);
      }
      await pg.query(
        "DELETE FROM mcp_tool_audit WHERE correlation_id LIKE $1",
        [scope]
      );
    } finally {
      await pg.end();
    }
    await transport.terminateSession();
    await client.close();
  });
});
