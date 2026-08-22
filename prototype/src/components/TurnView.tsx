"use client";

import { motion } from "framer-motion";
import { Bot, Copy, FileText, Pencil } from "lucide-react";
import { useState } from "react";
import { BlockList, Callout } from "@/components/blocks/BlockList";
import { RoutePanel } from "@/components/RoutePanel";
import type { ChatTurn } from "@/lib/chat-types";

const DATASET_LABELS: Record<string, string> = {
  population_observation: "인구 DB",
  local_tax_revenue: "세무 원장",
  press_release: "보도자료",
  council_bill: "의안 기록",
  council_record: "회의록",
  policy_program: "정책 사업",
  document: "첨부 문서"
};

function connectedLabel(turn: ChatTurn): string {
  const reply = turn.reply;
  if (!reply) return "";
  const used = Array.from(new Set(reply.route.plan.map((step) => step.datasetId)));
  if (used.length === 0) return "연결된 데이터 없음";
  return `${used.map((id) => DATASET_LABELS[id] ?? id).join(" | ")} 연결됨`;
}

function relativeTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

export function TurnView({ turn }: { turn: ChatTurn }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-[70%] rounded-2xl bg-ink-800 px-5 py-4 text-[13.5px] leading-6 whitespace-pre-wrap"
        >
          {turn.question}
        </motion.div>
      </div>

      <div className="flex gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-mint-400 text-ink-950">
          <Bot size={18} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-bold">G : TEXFLOW</span>
            <span className="text-[11.5px] text-muted">{connectedLabel(turn)}</span>
            <span className="ml-auto flex items-center gap-2 text-[11px] text-muted">
              {relativeTime(turn.createdAt)}
              <Pencil size={13} className="opacity-60" />
              <button
                type="button"
                aria-label="요약 복사"
                onClick={() => {
                  if (!turn.reply) return;
                  navigator.clipboard?.writeText(turn.reply.view.summary).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    },
                    () => undefined
                  );
                }}
              >
                <Copy size={13} className={copied ? "text-mint-400" : "opacity-60"} />
              </button>
            </span>
          </div>

          <div className="mt-3">
            {turn.status === "pending" ? <Pending /> : null}

            {turn.status === "error" ? (
              <Callout
                tone="danger"
                title="답변을 가져오지 못했습니다"
                text={turn.error ?? "알 수 없는 오류"}
              />
            ) : null}

            {turn.reply ? (
              <>
                <BlockList blocks={turn.reply.view.blocks} />

                {turn.reply.sources.length > 0 ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-muted">출처</span>
                    {turn.reply.sources.slice(0, 6).map((source) => (
                      <span
                        key={source.id || source.title}
                        title={source.id}
                        className="inline-flex items-center gap-1 rounded-lg bg-panel-soft px-2.5 py-1 text-[11px] text-[#c7ccd3]"
                      >
                        <FileText size={11} />
                        {source.publisher ?? source.title}
                      </span>
                    ))}
                    {turn.reply.sources.length > 6 ? (
                      <span className="text-[11px] text-muted">
                        외 {turn.reply.sources.length - 6}건
                      </span>
                    ) : null}
                  </div>
                ) : null}

                <RoutePanel route={turn.reply.route} />

                <p className="mt-2 text-[10.5px] text-[#5f646c]">
                  도구 선택 {turn.reply.planner} · 화면 구성 {turn.reply.composer}
                  {turn.reply.degraded ? ` · ${turn.reply.degraded}` : ""}
                </p>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Pending() {
  return (
    <div className="space-y-2">
      <div className="shimmer h-4 w-40 rounded bg-white/10" />
      <div className="shimmer h-24 rounded-2xl bg-white/5" />
      <p className="text-[11px] text-muted">
        카탈로그를 검색하고 도구를 호출해 근거를 모으는 중입니다…
      </p>
    </div>
  );
}
