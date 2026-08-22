import { beforeAll, describe, expect, it } from "vitest";
import {
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema
} from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadDemoData } from "./data-store.js";
import { InMemoryDataRepository } from "./repository.js";
import { createToolRegistry } from "./tools.js";
import { createMcpServer } from "./mcp-server.js";
import { parseResourceUri } from "./mcp-resources.js";

describe("resource uri parsing", () => {
  it("reads a region evidence uri including its issue", () => {
    const parsed = parseResourceUri(
      "gyeongbuk://regions/%EC%9D%98%EC%84%B1%EA%B5%B0/evidence?issue=%EC%9D%B8%EA%B5%AC"
    );
    expect(parsed).toEqual({
      kind: "evidence",
      region: "의성군",
      issue: "인구"
    });
  });

  it("reads a source uri", () => {
    expect(parseResourceUri("gyeongbuk://sources/abc-123")).toEqual({
      kind: "source",
      sourceId: "abc-123"
    });
  });

  it("reads the catalog and a single dataset", () => {
    expect(parseResourceUri("gyeongbuk://datasets")).toEqual({ kind: "catalog" });
    expect(parseResourceUri("gyeongbuk://datasets/population_observation")).toEqual({
      kind: "dataset",
      datasetId: "population_observation"
    });
  });

  it("rejects another scheme rather than guessing at it", () => {
    expect(parseResourceUri("https://example.com/regions/a/evidence")).toBeNull();
    expect(parseResourceUri("gyeongbuk://regions/의성군")).toBeNull();
    expect(parseResourceUri("not a uri")).toBeNull();
  });
});

describe("mcp resources and prompts", () => {
  let client: Client;

  beforeAll(async () => {
    const registry = createToolRegistry(
      new InMemoryDataRepository(await loadDemoData())
    );
    const server = createMcpServer(registry);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);
  });

  it("advertises the resource and prompt capabilities to a client", async () => {
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.resources).toBeDefined();
    expect(capabilities?.prompts).toBeDefined();
  });

  it("lists one resource per dataset plus the catalog itself", async () => {
    const listed = await client.request(
      { method: "resources/list" },
      ListResourcesResultSchema
    );
    const uris = listed.resources.map((resource) => resource.uri);
    expect(uris).toContain("gyeongbuk://datasets");
    expect(uris).toContain("gyeongbuk://datasets/population_observation");
  });

  it("offers templates for the two addressable bundles", async () => {
    const listed = await client.request(
      { method: "resources/templates/list" },
      ListResourceTemplatesResultSchema
    );
    const templates = listed.resourceTemplates.map(
      (template) => template.uriTemplate
    );
    expect(templates).toContain(
      "gyeongbuk://regions/{region}/evidence?issue={issue}"
    );
    expect(templates).toContain("gyeongbuk://sources/{sourceId}");
  });

  it("serves the catalog with each dataset's claim boundary attached", async () => {
    const read = await client.request(
      { method: "resources/read", params: { uri: "gyeongbuk://datasets" } },
      ReadResourceResultSchema
    );
    const payload = JSON.parse(read.contents[0]!.text as string) as {
      datasets: Array<{ evidenceContract: { canClaim: string[] } }>;
    };
    expect(payload.datasets.length).toBeGreaterThan(0);
    for (const dataset of payload.datasets) {
      expect(dataset.evidenceContract.canClaim.length).toBeGreaterThan(0);
    }
  });

  it("refuses an evidence uri that carries no issue instead of inventing one", async () => {
    await expect(
      client.request(
        {
          method: "resources/read",
          params: { uri: "gyeongbuk://regions/포항시/evidence" }
        },
        ReadResourceResultSchema
      )
    ).rejects.toThrow(/issue/);
  });

  it("lists both investigation procedures", async () => {
    const listed = await client.request(
      { method: "prompts/list" },
      ListPromptsResultSchema
    );
    expect(listed.prompts.map((prompt) => prompt.name).sort()).toEqual([
      "draft_civic_action",
      "investigate_regional_issue"
    ]);
  });

  it("builds an investigation prompt that names the tools and the refusal rule", async () => {
    const prompt = await client.request(
      {
        method: "prompts/get",
        params: {
          name: "investigate_regional_issue",
          arguments: { region: "의성군", issue: "인구 감소" }
        }
      },
      GetPromptResultSchema
    );
    const text = prompt.messages[0]!.content.text as string;
    expect(text).toContain("의성군");
    expect(text).toContain("search_datasets");
    expect(text).toContain("build_regional_evidence_pack");
    expect(text).toContain("추정하지 말고");
    expect(text).not.toContain("{{");
  });

  it("keeps the optional question out of the prompt when it was not given", async () => {
    const prompt = await client.request(
      {
        method: "prompts/get",
        params: {
          name: "investigate_regional_issue",
          arguments: { region: "의성군", issue: "인구 감소" }
        }
      },
      GetPromptResultSchema
    );
    expect(prompt.messages[0]!.content.text).not.toContain("답해야 할 질문");
  });

  it("rejects a prompt request that omits a required argument", async () => {
    await expect(
      client.request(
        {
          method: "prompts/get",
          params: { name: "draft_civic_action", arguments: { region: "의성군" } }
        },
        GetPromptResultSchema
      )
    ).rejects.toThrow(/issue/);
  });

  it("tells the drafter to move unverified content into a disclosure request", async () => {
    const prompt = await client.request(
      {
        method: "prompts/get",
        params: {
          name: "draft_civic_action",
          arguments: { region: "의성군", issue: "인구 감소" }
        }
      },
      GetPromptResultSchema
    );
    const text = prompt.messages[0]!.content.text as string;
    expect(text).toContain("정보공개청구 항목으로 옮기십시오");
    expect(text).toContain("성과나 실패에 대한 판단을 쓰지 마십시오");
  });
});
