"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Route, ShieldX, Sigma, Table2 } from "lucide-react";
import type { RouteTrace } from "@/lib/chat-types";

/**
 * 에이전트가 지나온 경로.
 *
 * 결론만 보여주면 이 시스템이 검색엔진과 무엇이 다른지 알 수 없다. 어떤
 * 데이터셋이 후보로 올라왔고, 어떤 도구가 어떤 인자로 불렸고, 무엇이 거절됐고,
 * 어떤 테이블이 비어 있었는지가 전부 감사 가능해야 한다.
 */
export function RoutePanel({ route }: { route: RouteTrace }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 rounded-2xl bg-panel/40 ring-1 ring-white/5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-[11.5px] text-muted transition-colors hover:text-[#d5d9de]"
      >
        <Route size={13} />
        에이전트 경로
        <span className="text-[#5f646c]">
          후보 {route.consideredDatasets.length} · 호출 {route.plan.length} · 근거{" "}
          {route.evidenceCount} · 출처 {route.sourceCount}
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="ml-auto">
          <ChevronDown size={14} />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-4 border-t border-white/5 px-4 py-4 text-[11.5px]">
              <Section icon={<Table2 size={12} />} title="카탈로그 후보">
                {route.consideredDatasets.length === 0 ? (
                  <Empty>후보 데이터셋이 없었습니다. 이 질문은 보유 범위 밖입니다.</Empty>
                ) : (
                  <ul className="space-y-1.5">
                    {route.consideredDatasets.map((dataset) => (
                      <li key={dataset.datasetId} className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-[#d5d9de]">{dataset.title}</span>
                        <code className="text-[10px] text-[#6b7079]">{dataset.datasetId}</code>
                        {dataset.matchedTerms.map((term) => (
                          <span
                            key={term}
                            className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted"
                          >
                            {term}
                          </span>
                        ))}
                        {!dataset.available ? (
                          <span className="text-[10px] text-amber-300/80">행 없음</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section icon={<Sigma size={12} />} title="도구 호출">
                {route.plan.length === 0 ? (
                  <Empty>실행된 도구가 없습니다.</Empty>
                ) : (
                  <ul className="space-y-2">
                    {route.plan.map((step, index) => (
                      <li key={`${step.tool}-${index}`}>
                        <p className="font-medium text-mint-400/90">{step.tool}</p>
                        <pre className="mt-1 overflow-x-auto rounded-lg bg-black/25 px-2.5 py-2 text-[10.5px] text-[#9aa1aa]">
                          {JSON.stringify(step.arguments)}
                        </pre>
                        <p className="mt-1 text-muted">{step.reason}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {route.joins.length > 0 ? (
                <Section icon={<Sigma size={12} />} title="결합">
                  <ul className="space-y-1.5">
                    {route.joins.map((join, index) => (
                      <li key={index} className="text-muted">
                        <span className="text-[#d5d9de]">
                          {join.from} × {join.to}
                        </span>{" "}
                        · key {join.joinKeys.join(", ")}
                        {join.caveats.map((caveat) => (
                          <p key={caveat} className="mt-0.5 text-amber-300/70">
                            {caveat}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {route.rejectedSteps.length > 0 ? (
                <Section icon={<ShieldX size={12} />} title="거부된 호출">
                  <ul className="space-y-1">
                    {route.rejectedSteps.map((rejected, index) => (
                      <li key={index} className="text-rose-200/80">
                        <code className="text-[10.5px]">{rejected.step.tool}</code> ·{" "}
                        {rejected.reason}
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {route.unavailableDatasets.length > 0 ? (
                <Section icon={<Table2 size={12} />} title="비어 있는 데이터셋">
                  <ul className="space-y-1">
                    {route.unavailableDatasets.map((dataset) => (
                      <li key={dataset.datasetId} className="text-amber-200/80">
                        {dataset.title}
                        {dataset.note ? ` · ${dataset.note}` : ""}
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Section({
  icon,
  title,
  children
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] text-[#6b7079] uppercase">
        {icon}
        {title}
      </p>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted">{children}</p>;
}
