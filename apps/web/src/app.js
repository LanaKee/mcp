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

/** The strongest status among the evidence, so the badge never overstates. */
function evidenceStatus(result) {
  const statuses = new Set((result.evidence ?? []).map((item) => item.dataStatus));
  if (statuses.size === 0) return "no data";
  if (statuses.size === 1) return [...statuses][0];
  return [...statuses].join(" + ");
}

function renderResult(result) {
  text(document.querySelector("#result-question"), result.question);
  text(document.querySelector("#conclusion"), result.conclusion);
  text(
    document.querySelector("#status-badge"),
    String(result.data_status ?? evidenceStatus(result)).toUpperCase()
  );

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
        text(badge, item.dataStatus);
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

askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = askInput.value.trim();
  if (question.length === 0) return;
  askAgent(question, askSubmit);
});

boot().catch((error) => {
  text(questionList, `질문을 불러오지 못했습니다: ${error.message}`);
});
