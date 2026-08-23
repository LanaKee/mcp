"use client";

import { motion } from "framer-motion";
import {
  CheckCircle,
  CircleNotch,
  Copy,
  FileText,
  Ghost,
  PencilSimple
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
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
    <div className="space-y-5">
      {/* 사용자의 말은 초록 말풍선, 시각과 도구는 그 아래 오른쪽에 둔다.
          목업의 배치이기도 하고, 시각이 답변 머리글에 있으면 그 시각이
          질문 시각인지 답변 시각인지 읽는 사람이 알 수 없다. */}
      <div className="flex flex-col items-end gap-1.5">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-[85%] rounded-2xl bg-mint-400 px-4 py-3 text-[13.5px] leading-6 whitespace-pre-wrap text-ink-950 sm:max-w-[70%] sm:px-5 sm:py-3.5"
        >
          {turn.question}
        </motion.div>

        <div className="flex items-center gap-2 pr-1 text-[11px] text-muted">
          {relativeTime(turn.createdAt)}
          <PencilSimple size={13} className="opacity-60" />
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
        </div>
      </div>

      <div className="flex gap-2.5 sm:gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-mint-400 text-ink-950">
          <Ghost size={19} weight="fill" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-4 font-bold">G : TEXFLOW</p>
          <p className="mt-0.5 truncate text-[11.5px] leading-4 text-muted">
            {connectedLabel(turn)}
          </p>

          <div className="mt-3">
            {turn.status === "pending" ? (
              <Pending progress={turn.progress} startedAt={turn.createdAt} />
            ) : null}

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

/**
 * 기다리는 동안의 화면.
 *
 * 두 모델을 거치므로 답까지 수십 초가 걸린다. 그 시간을 회전하는 점 하나로
 * 때우는 대신, 서버가 실제로 지나간 단계와 실제로 고른 도구를 그대로 보여준다.
 * 여기에 표시되는 모든 문장은 서버가 보낸 것이고, 화면이 지어낸 진행 상황은
 * 하나도 없다.
 */
function Pending({
  progress,
  startedAt
}: {
  progress: ChatTurn["progress"];
  startedAt: number;
}) {
  const elapsed = useElapsed(startedAt);
  const stages = progress?.stages ?? [];
  const tools = progress?.tools ?? [];
  const blocks = progress?.blocks ?? [];
  const reasoning = progress?.reasoning ?? "";

  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-panel/70 p-4 ring-1 ring-white/5">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
            추론 과정
          </p>
          <span className="text-[11px] tabular-nums text-muted">{elapsed}초</span>
        </div>

        <ol className="mt-3 space-y-2.5">
          {stages.length === 0 ? (
            <StageRow label="에이전트에 질문을 전달하는 중" state="running" />
          ) : null}
          {stages.map((stage, index) => (
            <StageRow
              key={`${stage.id}-${index}`}
              label={stage.label}
              detail={stage.detail}
              state={stage.state}
            />
          ))}
        </ol>

        {reasoning.length > 0 ? (
          <div className="mt-3 border-t border-white/5 pt-3">
            {/* 추론 요약은 수천 자가 되기도 한다. 진행을 보여주려는 것이므로
                가장 최근 대목만 남기고, 완결된 주장으로 읽히지 않도록 흐린다. */}
            <p className="max-h-24 overflow-hidden text-[11px] leading-4 whitespace-pre-wrap text-[#6d727a]">
              {reasoning.slice(-400)}
            </p>
          </div>
        ) : null}

        {tools.length > 0 ? (
          <div className="mt-3 space-y-1.5 border-t border-white/5 pt-3">
            {tools.map((tool, index) => (
              <motion.p
                key={`${tool.tool}-${index}`}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                className="text-[11px] leading-4 text-[#9aa0a8]"
              >
                <span className="text-mint-400">{tool.tool}</span>
                {tool.datasetId ? (
                  <span className="text-[#5f646c]"> · {tool.datasetId}</span>
                ) : null}
                {tool.reason ? <span className="block text-[#6d727a]">{tool.reason}</span> : null}
              </motion.p>
            ))}
          </div>
        ) : null}
      </div>

      {progress?.summary ? (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-[13px] leading-6 text-[#c7ccd3]"
        >
          {progress.summary}
        </motion.p>
      ) : null}

      {blocks.length > 0 ? (
        <BlockList blocks={blocks} />
      ) : (
        <div className="shimmer h-24 rounded-2xl bg-white/5" />
      )}
    </div>
  );
}

function StageRow({
  label,
  detail,
  state
}: {
  label: string;
  detail?: string;
  state: "running" | "done";
}) {
  return (
    <li className="flex gap-2.5">
      {state === "done" ? (
        <CheckCircle size={15} weight="fill" className="mt-px shrink-0 text-mint-400" />
      ) : (
        <CircleNotch size={15} className="mt-px shrink-0 animate-spin text-muted" />
      )}
      <div className="min-w-0">
        <p className={`text-[12px] leading-4 ${state === "done" ? "text-[#c7ccd3]" : ""}`}>
          {label}
        </p>
        {detail ? <p className="mt-0.5 text-[11px] text-[#6d727a]">{detail}</p> : null}
      </div>
    </li>
  );
}

/** 경과 시간을 초 단위로 센다. 얼마나 기다렸는지 알면 기다림이 덜 답답하다. */
function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}
