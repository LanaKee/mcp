import {
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DATASET_CATALOG } from "@gb/domain";
import { executeTool, type ToolRegistry } from "./tools.js";

export const RESOURCE_SCHEME = "gyeongbuk";

/**
 * Resources exist here for a reason tools cannot serve.
 *
 * A tool call is a private event: the client that made it holds the result, and
 * a second client asking the same question re-runs the work and may get a
 * differently shaped answer. A resource is addressable, so two different AI
 * clients investigating 의성군 인구 감소 read the same URI and therefore reason
 * over the same evidence bundle with the same limitations attached. For a
 * project whose whole claim is that conclusions must be traceable to a fixed
 * body of evidence, that shared address is the point.
 */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface ParsedUri {
  kind: "catalog" | "dataset" | "evidence" | "source";
  region?: string;
  datasetId?: string;
  sourceId?: string;
  issue?: string;
}

export function parseResourceUri(raw: string): ParsedUri | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${RESOURCE_SCHEME}:`) return null;
  // gyeongbuk://regions/의성군/evidence parses with host="regions", so the host
  // and path have to be recombined before splitting.
  const segments = [url.hostname, ...url.pathname.split("/")]
    .filter((segment) => segment.length > 0)
    .map(decodeSegment);

  if (segments.length === 1 && segments[0] === "datasets") return { kind: "catalog" };
  if (segments.length === 2 && segments[0] === "datasets") {
    return { kind: "dataset", datasetId: segments[1]! };
  }
  if (segments.length === 2 && segments[0] === "sources") {
    return { kind: "source", sourceId: segments[1]! };
  }
  if (
    segments.length === 3 &&
    segments[0] === "regions" &&
    segments[2] === "evidence"
  ) {
    return {
      kind: "evidence",
      region: segments[1]!,
      issue: url.searchParams.get("issue") ?? undefined
    };
  }
  return null;
}

export function registerResources(server: Server, registry: ToolRegistry): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: `${RESOURCE_SCHEME}://datasets`,
        name: "데이터셋 카탈로그",
        description:
          "적재된 데이터셋의 의미, 측정 단위, 증거 역할, 조인 가능성, 그리고 각 데이터셋으로 주장할 수 있는 것과 없는 것.",
        mimeType: "application/json"
      },
      ...DATASET_CATALOG.map((dataset) => ({
        uri: `${RESOURCE_SCHEME}://datasets/${dataset.datasetId}`,
        name: dataset.title,
        description: dataset.description,
        mimeType: "application/json"
      }))
    ]
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${RESOURCE_SCHEME}://regions/{region}/evidence?issue={issue}`,
        name: "지역 현안 근거 묶음",
        description:
          "한 지역의 한 현안에 대한 관측 통계, 서술 맥락, 근거 공백, 그리고 그 공백을 메울 행정 행동. 같은 URI를 읽은 클라이언트는 같은 근거와 같은 한계를 공유합니다.",
        mimeType: "application/json"
      },
      {
        uriTemplate: `${RESOURCE_SCHEME}://sources/{sourceId}`,
        name: "출처 원문 위치",
        description:
          "source_id의 원문 파일, 행·페이지 위치, 기준일, 데이터 상태, 인용 맥락.",
        mimeType: "application/json"
      }
    ]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const uri = request.params.uri;
    const parsed = parseResourceUri(uri);
    if (!parsed) {
      throw new Error(
        `알 수 없는 리소스 URI입니다: ${uri}. 사용 가능한 형식은 ${RESOURCE_SCHEME}://datasets, ${RESOURCE_SCHEME}://datasets/{datasetId}, ${RESOURCE_SCHEME}://regions/{region}/evidence?issue={issue}, ${RESOURCE_SCHEME}://sources/{sourceId} 입니다.`
      );
    }
    const context = { signal: extra?.signal };
    const emit = (payload: unknown) => ({
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2)
        }
      ]
    });

    if (parsed.kind === "catalog") {
      // Served from the catalog rather than through search_datasets because a
      // listing is not a query: ranking it against a search term would make the
      // resource's content depend on something the URI does not carry.
      return emit({
        datasets: DATASET_CATALOG.map((dataset) => ({
          datasetId: dataset.datasetId,
          title: dataset.title,
          description: dataset.description,
          evidenceRole: dataset.evidenceRole,
          evidenceContract: dataset.evidenceContract,
          grain: dataset.grain,
          measures: dataset.measures,
          usageRules: dataset.usageRules,
          uri: `${RESOURCE_SCHEME}://datasets/${dataset.datasetId}`
        }))
      });
    }

    if (parsed.kind === "dataset") {
      return emit(
        await executeTool(
          registry,
          "describe_dataset",
          { datasetId: parsed.datasetId, includeCoverage: true },
          context
        )
      );
    }

    if (parsed.kind === "source") {
      return emit(
        await executeTool(
          registry,
          "get_source_context",
          { sourceIds: [parsed.sourceId] },
          context
        )
      );
    }

    if (!parsed.issue) {
      throw new Error(
        "근거 묶음 URI에는 issue 질의 문자열이 필요합니다. 예: gyeongbuk://regions/의성군/evidence?issue=인구%20감소"
      );
    }
    const now = new Date().getUTCFullYear();
    return emit(
      await executeTool(
        registry,
        "build_regional_evidence_pack",
        {
          region: parsed.region,
          issue: parsed.issue,
          // A URI has to resolve to one bundle, so the window is fixed rather
          // than negotiated. Ten years back covers every series loaded, and a
          // caller who needs a different window should call the tool.
          startYear: now - 10,
          endYear: now
        },
        context
      )
    );
  });
}
