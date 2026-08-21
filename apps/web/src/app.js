const questionList = document.querySelector("#question-list");
const resultSection = document.querySelector("#result");
const emptyState = document.querySelector("#empty-state");

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

function renderResult(result) {
  text(document.querySelector("#result-question"), result.question);
  text(document.querySelector("#conclusion"), result.conclusion);
  text(document.querySelector("#status-badge"), String(result.data_status).toUpperCase());

  renderItems(
    document.querySelector("#evidence"),
    result.evidence ?? [],
    (node, item) => {
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

async function runQuestion(questionId, button) {
  document.body.classList.add("loading");
  button.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/demo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error?.message ?? "요청에 실패했습니다.");
    }
    renderResult(result);
  } catch (error) {
    resultSection.hidden = false;
    emptyState.hidden = true;
    text(document.querySelector("#result-question"), "오류");
    const conclusion = document.querySelector("#conclusion");
    conclusion.className = "error";
    text(conclusion, error instanceof Error ? error.message : String(error));
  } finally {
    document.body.classList.remove("loading");
    button.removeAttribute("aria-busy");
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
      button.addEventListener("click", () => runQuestion(item.id, button));
      return button;
    })
  );
}

boot().catch((error) => {
  text(questionList, `질문을 불러오지 못했습니다: ${error.message}`);
});
