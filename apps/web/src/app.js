const questionList = document.querySelector("#question-list");
const resultSection = document.querySelector("#result");
const emptyState = document.querySelector("#empty-state");
const askForm = document.querySelector("#ask-form");
const askInput = document.querySelector("#ask-input");
const askSubmit = document.querySelector("#ask-submit");

function text(element, value) {
  element.textContent = value ?? "";
}

function renderItems(container, items, renderer, className) {
  container.replaceChildren(
    ...items.map((item) => {
      const node = document.createElement("div");
      node.className = className;
      renderer(node, item);
      return node;
    })
  );
}

/**
 * Renders the route the agent took.
 *
 * Shown before the answer on purpose: the point of this prototype is that the
 * dataset choice and tool choice are made at runtime and can be audited, so
 * hiding the route would hide the thing worth demonstrating.
 */
function renderTrail(result) {
  const trail = document.querySelector("#trail");
  const steps = [];

  const considered = result.consideredDatasets ?? [];
  steps.push({
    label: "카탈로그 검색",
    body:
      considered.length > 0
        ? considered
            .map(
              (item) =>
                `${item.title}${
                  item.matchedTerms?.length
                    ? ` (일치: ${item.matchedTerms.slice(0, 4).join(", ")})`
                    : ""
                }${item.available ? "" : " · 적재된 행 없음"}`
            )
            .join("\n")
        : "후보 데이터셋 없음"
  });

  const plan = result.plan ?? [];
  steps.push({
    label: "도구 선택",
    body:
      plan.length > 0
        ? plan
            .map(
              (step) =>
                `${step.tool}(${Object.entries(step.arguments ?? {})
                  .filter(([, value]) => value !== undefined && value !== null)
                  .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                  .join(", ")})`
            )
            .join("\n")
        : "호출할 도구를 정하지 못함"
  });

  const rejected = result.rejectedSteps ?? [];
  if (rejected.length > 0) {
    steps.push({
      label: "거부된 호출",
      body: rejected.map((item) => `${item.step.tool}: ${item.reason}`).join("\n"),
      tone: "warn"
    });
  }

  const unavailable = result.unavailableDatasets ?? [];
  if (unavailable.length > 0) {
    steps.push({
      label: "비어 있는 데이터셋",
      body: unavailable
        .map((item) => `${item.title}${item.note ? ` · ${item.note}` : ""}`)
        .join("\n"),
      tone: "warn"
    });
  }

  steps.push({
    label: "근거 수집",
    body:
      (result.evidence ?? []).length > 0
        ? `${result.evidence.length}건 · 출처 ${(result.sources ?? []).length}건`
        : "근거 없음"
  });

  trail.replaceChildren(
    ...steps.map((step) => {
      const node = document.createElement("li");
      if (step.tone) node.className = `trail-item trail-item--${step.tone}`;
      else node.className = "trail-item";
      const label = document.createElement("strong");
      text(label, step.label);
      const body = document.createElement("pre");
      text(body, step.body);
      node.append(label, body);
      return node;
    })
  );
}

function renderJoins(result) {
  const panel = document.querySelector("#joins-panel");
  const joins = result.joins ?? [];
  if (joins.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  renderItems(
    document.querySelector("#joins"),
    joins,
    (node, join) => {
      const title = document.createElement("strong");
      text(title, `${join.from} ⟷ ${join.to} · ${join.joinKeys.join(", ")}`);
      const rationale = document.createElement("p");
      text(rationale, join.rationale);
      node.append(title, rationale);
      for (const caveat of join.caveats ?? []) {
        const item = document.createElement("small");
        text(item, `주의: ${caveat}`);
        node.append(item);
      }
    },
    "join-item"
  );
}

/**
 * Data statuses in the reader's language.
 *
 * The raw values are internal vocabulary. `official_observed` shouted in caps
 * tells a citizen nothing, and the markup previously shipped `DEMO SAMPLE` as
 * the default badge, so a page that had not yet fetched anything claimed a data
 * status it had never received.
 */
const STATUS_LABELS = {
  official_observed: "공식 관측",
  demo_sample: "데모 표본",
  catalog_only: "목록만 등재",
  incomparable: "비교 불가",
  narrative_context_only: "서술 맥락",
  mixed: "혼합",
  empty: "근거 없음"
};

function statusLabel(value) {
  return STATUS_LABELS[value] ?? value;
}

/** The status the answer actually rests on, so the badge never overstates. */
function evidenceStatus(result) {
  const statuses = [...new Set((result.evidence ?? []).map((item) => item.dataStatus))];
  if (statuses.length === 0) return "근거 없음";
  return statuses.map(statusLabel).join(" + ");
}

/** A labelled bullet list of what a piece of evidence may or may not support. */
function claimList(label, claims, tone) {
  const wrapper = document.createElement("div");
  wrapper.className = `claim claim--${tone}`;
  const heading = document.createElement("small");
  text(heading, label);
  const list = document.createElement("ul");
  list.replaceChildren(
    ...(claims ?? []).map((claim) => {
      const item = document.createElement("li");
      text(item, claim);
      return item;
    })
  );
  wrapper.append(heading, list);
  return wrapper;
}

function renderResult(result) {
  text(document.querySelector("#result-question"), result.question);
  text(document.querySelector("#conclusion"), result.conclusion);
  const statusBadge = document.querySelector("#status-badge");
  statusBadge.classList.remove("badge--pending");
  text(statusBadge, evidenceStatus(result));

  const plannerBadge = document.querySelector("#planner-badge");
  if (result.planner) {
    plannerBadge.hidden = false;
    text(plannerBadge, `PLANNER ${result.planner}`);
  } else {
    plannerBadge.hidden = true;
  }

  if (result.consideredDatasets || result.plan) {
    document.querySelector(".trail").hidden = false;
    renderTrail(result);
    renderJoins(result);
  } else {
    document.querySelector(".trail").hidden = true;
    document.querySelector("#joins-panel").hidden = true;
  }

  renderItems(
    document.querySelector("#evidence"),
    result.evidence ?? [],
    (node, item) => {
      if (item.dataStatus) {
        const badge = document.createElement("small");
        badge.className = `evidence-status evidence-status-${item.dataStatus}`;
        text(badge, statusLabel(item.dataStatus));
        node.append(badge);
      }
      const statement = document.createElement("strong");
      text(statement, item.statement);
      node.append(statement);
      if (item.detail) {
        const detail = document.createElement("p");
        text(detail, Array.isArray(item.detail) ? item.detail.join(" · ") : item.detail);
        node.append(detail);
      }
      // The claim boundary belongs next to the number it constrains. Left in a
      // shared limitations list, a reader has to work out which caveat applies
      // to which figure, which in practice means none of them do.
      if (item.evidenceContract) {
        node.append(claimList("이 근거로 말할 수 있는 것", item.evidenceContract.canClaim, "can"));
        node.append(
          claimList("이 근거로 말할 수 없는 것", item.evidenceContract.cannotClaim, "cannot")
        );
        if (item.evidenceContract.insteadUse) {
          const instead = document.createElement("small");
          instead.className = "claim-instead";
          text(instead, `대신 필요한 자료: ${item.evidenceContract.insteadUse}`);
          node.append(instead);
        }
      }
    },
    "evidence-item"
  );

  renderItems(
    document.querySelector("#sources"),
    result.sources ?? [],
    (node, source) => {
      const title = document.createElement("strong");
      text(title, source.title);
      const meta = document.createElement("small");
      text(
        meta,
        `${source.provider} · ${source.dataStatus} · ${source.locator ?? "위치 미제공"}`
      );
      node.append(title, meta);
    },
    "source-item"
  );

  const limitations = document.querySelector("#limitations");
  limitations.replaceChildren(
    ...(result.limitations ?? []).map((item) => {
      const node = document.createElement("li");
      text(node, item);
      return node;
    })
  );
  emptyState.hidden = true;
  resultSection.hidden = false;
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function askAgent(question, busyElement) {
  document.body.classList.add("loading");
  busyElement?.setAttribute("aria-busy", "true");
  const conclusion = document.querySelector("#conclusion");
  conclusion.className = "";
  try {
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error?.message ?? "요청에 실패했습니다.");
    }
    renderResult(result);
  } catch (error) {
    resultSection.hidden = false;
    emptyState.hidden = true;
    text(document.querySelector("#result-question"), question);
    conclusion.className = "error";
    text(conclusion, error instanceof Error ? error.message : String(error));
  } finally {
    document.body.classList.remove("loading");
    busyElement?.removeAttribute("aria-busy");
  }
}

async function boot() {
  const response = await fetch("/api/questions");
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message ?? "질문을 불러오지 못했습니다.");
  }
  const { questions } = result;
  questionList.replaceChildren(
    ...questions.map((item, index) => {
      const button = document.createElement("button");
      button.className = "question-card";
      button.type = "button";
      const number = document.createElement("span");
      text(number, String(index + 1).padStart(2, "0"));
      const question = document.createElement("strong");
      text(question, item.question);
      button.append(number, question);
      // Preset questions go through the same agent path as a typed question,
      // so the demo never shows a route the user could not reproduce.
      button.addEventListener("click", () => {
        askInput.value = item.question;
        askAgent(item.question, button);
      });
      return button;
    })
  );
}

/* ------------------------------------------------------------------ *
 * Regional evidence graph
 *
 * The agent panel above answers a question. This panel does the thing the
 * project actually claims to do: it shows the evidence chain behind an issue,
 * including the part that is missing, and turns the missing part into a
 * document a resident can file. The gap column is the one that matters — a
 * search tool can always show what exists, and the expensive discovery when
 * using public data is that the number you need was never published.
 * ------------------------------------------------------------------ */

const packForm = document.querySelector("#pack-form");
const packResult = document.querySelector("#pack-result");
const packError = document.querySelector("#pack-error");
let currentPackInput = null;

async function callTool(name, body) {
  const response = await fetch(`/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "요청에 실패했습니다.");
  }
  return payload;
}

function graphNode(node, kind) {
  const article = document.createElement("article");
  article.className = `graph-node graph-node--${kind}`;

  const badge = document.createElement("small");
  badge.className = `evidence-status evidence-status-${node.dataStatus}`;
  text(badge, statusLabel(node.dataStatus));

  const title = document.createElement("strong");
  text(title, node.title);

  const summary = document.createElement("p");
  text(summary, node.summary);

  const tool = document.createElement("small");
  tool.className = "graph-node__tool";
  text(tool, `${node.tool} · 출처 ${node.sourceIds.length}건`);

  article.append(badge, title, summary, tool);
  if (node.contract) {
    article.append(claimList("말할 수 있는 것", node.contract.canClaim, "can"));
    article.append(claimList("말할 수 없는 것", node.contract.cannotClaim, "cannot"));
    if (node.contract.insteadUse) {
      const instead = document.createElement("small");
      instead.className = "claim-instead";
      text(instead, `대신 필요한 자료: ${node.contract.insteadUse}`);
      article.append(instead);
    }
  }
  return article;
}

function graphColumn(heading, note, nodes, kind, emptyMessage) {
  const column = document.createElement("div");
  column.className = "graph-column";
  const title = document.createElement("h4");
  text(title, heading);
  const subtitle = document.createElement("small");
  text(subtitle, note);
  column.append(title, subtitle);
  if (nodes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "graph-empty";
    text(empty, emptyMessage);
    column.append(empty);
  } else {
    column.append(...nodes.map((node) => graphNode(node, kind)));
  }
  return column;
}

function renderGraph(pack) {
  const graph = document.querySelector("#evidence-graph");
  const issue = document.createElement("div");
  issue.className = "graph-column graph-column--issue";
  const issueTitle = document.createElement("h4");
  text(issueTitle, `${pack.region} · ${pack.issue}`);
  const issueNote = document.createElement("small");
  text(
    issueNote,
    `${pack.period.startYear}~${pack.period.endYear}년 · 조인 ${pack.links.length}건`
  );
  issue.append(issueTitle, issueNote);
  for (const link of pack.links) {
    const item = document.createElement("p");
    item.className = "graph-link";
    text(item, `${link.from} ⟷ ${link.to} · ${link.joinKeys.join(", ")}`);
    issue.append(item);
  }

  graph.replaceChildren(
    graphColumn(
      "관측 통계",
      "수치 주장을 뒷받침할 수 있는 자료",
      pack.observed,
      "observed",
      "이 현안을 측정한 관측 통계가 적재되어 있지 않습니다."
    ),
    issue,
    graphColumn(
      "서술 맥락",
      "무엇이 언제 계획·발표·논의되었는지만 알려 주는 자료",
      pack.context,
      "context",
      "관련 계획·발표·논의 기록을 찾지 못했습니다."
    )
  );
}

function renderGaps(pack) {
  renderItems(
    document.querySelector("#pack-gaps"),
    pack.gaps,
    (node, gap) => {
      const question = document.createElement("strong");
      text(question, gap.question);
      const reason = document.createElement("p");
      text(reason, gap.reason);
      const closed = document.createElement("small");
      text(closed, `필요한 자료: ${gap.wouldBeClosedBy}`);
      const holder = document.createElement("small");
      text(holder, `보유 기관: ${gap.holder}`);
      node.append(question, reason, closed, holder);
    },
    "gap-item"
  );
  if (pack.gaps.length === 0) {
    const none = document.createElement("p");
    text(none, "적재된 자료로 답할 수 없는 질문이 확인되지 않았습니다.");
    document.querySelector("#pack-gaps").replaceChildren(none);
  }
}

function renderActions(pack) {
  renderItems(
    document.querySelector("#pack-actions"),
    pack.recommendedActions ?? [],
    (node, action) => {
      const title = document.createElement("strong");
      text(title, action.action);
      const rationale = document.createElement("p");
      text(rationale, action.rationale);
      const to = document.createElement("small");
      text(to, `제출처: ${action.addressedTo}`);
      node.append(title, rationale, to);
    },
    "action-item"
  );
}

function renderTimeline(timeline) {
  const list = document.querySelector("#pack-timeline");
  if (!timeline || timeline.entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "timeline-item";
    text(
      empty,
      "이 표현으로 검색되는 계획·발표·논의·발의 기록을 찾지 못했습니다. 기록이 없다는 증명은 아닙니다."
    );
    list.replaceChildren(empty);
    return;
  }
  const STAGE_LABELS = {
    plan: "계획",
    announcement: "발표",
    deliberation: "논의",
    legislation: "발의"
  };
  list.replaceChildren(
    ...timeline.entries.map((entry) => {
      const item = document.createElement("li");
      item.className = `timeline-item timeline-item--${entry.stage}`;
      const date = document.createElement("time");
      text(date, entry.date);
      const stage = document.createElement("span");
      stage.className = "timeline-stage";
      text(stage, STAGE_LABELS[entry.stage] ?? entry.stage);
      const title = document.createElement("strong");
      text(title, entry.title);
      const establishes = document.createElement("small");
      text(establishes, `이 기록이 입증하는 것: ${entry.establishes}`);
      const locator = document.createElement("small");
      locator.className = "timeline-locator";
      text(locator, entry.locator || "원문 위치 미제공");
      item.append(date, stage, title, establishes, locator);
      if (entry.url) {
        const link = document.createElement("a");
        link.href = entry.url;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        text(link, "원문 열기");
        item.append(link);
      }
      return item;
    })
  );
}

function renderPackLimitations(pack, timeline) {
  const merged = [...new Set([...(pack.limitations ?? []), ...(timeline?.limitations ?? [])])];
  document.querySelector("#pack-limitations").replaceChildren(
    ...merged.map((item) => {
      const node = document.createElement("li");
      text(node, item);
      return node;
    })
  );
}

async function buildPack(event) {
  event.preventDefault();
  const input = {
    region: document.querySelector("#pack-region").value.trim(),
    issue: document.querySelector("#pack-issue").value.trim(),
    startYear: Number(document.querySelector("#pack-start").value),
    endYear: Number(document.querySelector("#pack-end").value)
  };
  if (!input.region || !input.issue) return;
  const submit = document.querySelector("#pack-submit");
  submit.setAttribute("aria-busy", "true");
  document.body.classList.add("loading");
  packError.hidden = true;
  document.querySelector("#doc-output").hidden = true;
  try {
    // The timeline is fetched alongside rather than folded into the pack: they
    // answer different questions, and a caller who only wants one should not
    // pay for both.
    const [packResponse, timelineResponse] = await Promise.all([
      callTool("build_regional_evidence_pack", input),
      callTool("trace_policy_response", {
        region: input.region,
        issue: input.issue,
        limitPerStage: 5
      }).catch(() => null)
    ]);
    const pack = packResponse.result;
    currentPackInput = input;
    renderGraph(pack);
    renderGaps(pack);
    renderActions(pack);
    renderTimeline(timelineResponse?.result);
    renderPackLimitations(pack, timelineResponse?.result);
    packResult.hidden = false;
  } catch (error) {
    packResult.hidden = true;
    packError.hidden = false;
    text(packError, error instanceof Error ? error.message : String(error));
  } finally {
    submit.removeAttribute("aria-busy");
    document.body.classList.remove("loading");
  }
}

async function draftDocument(documentType) {
  if (!currentPackInput) return;
  const output = document.querySelector("#doc-output");
  const body = document.querySelector("#doc-text");
  document.body.classList.add("loading");
  try {
    const response = await callTool("draft_evidence_backed_action", {
      ...currentPackInput,
      documentType
    });
    const draft = `${response.result.draft}
`;
    text(body, draft);
    const link = document.querySelector("#doc-download");
    // Revoking the previous URL keeps repeated drafting from leaking blobs for
    // the lifetime of the page.
    if (link.dataset.objectUrl) URL.revokeObjectURL(link.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(
      new Blob([draft], { type: "text/plain;charset=utf-8" })
    );
    link.dataset.objectUrl = objectUrl;
    link.href = objectUrl;
    link.download = `${currentPackInput.region}_${currentPackInput.issue}_${
      documentType === "information_request" ? "정보공개청구서" : "주민참여예산제안서"
    }.txt`;
    output.hidden = false;
  } catch (error) {
    // A refusal here is the feature, not a failure: the tool declines to draft
    // a document the evidence cannot carry, and the reason is what the user
    // needs to read.
    text(body, error instanceof Error ? error.message : String(error));
    const link = document.querySelector("#doc-download");
    link.removeAttribute("href");
    output.hidden = false;
  } finally {
    document.body.classList.remove("loading");
  }
}

async function loadRegionOptions() {
  try {
    const response = await callTool("describe_dataset", {
      datasetId: "population_observation",
      includeCoverage: true
    });
    const regions = response.result.coverage?.regions ?? [];
    document.querySelector("#region-options").replaceChildren(
      ...regions.map((region) => {
        const option = document.createElement("option");
        option.value = typeof region === "string" ? region : region.region;
        return option;
      })
    );
  } catch {
    // A missing region list only costs autocomplete; the field stays typable.
  }
}

packForm.addEventListener("submit", buildPack);
for (const button of document.querySelectorAll(".doc-buttons button")) {
  button.addEventListener("click", () => draftDocument(button.dataset.doc));
}

askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = askInput.value.trim();
  if (question.length === 0) return;
  askAgent(question, askSubmit);
});

boot().catch((error) => {
  text(questionList, `질문을 불러오지 못했습니다: ${error.message}`);
});

loadRegionOptions();
