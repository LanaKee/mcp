"use client";

import { motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  Info,
  Minus,
  Warning,
  WarningOctagon
} from "@phosphor-icons/react";
import type { Block, MetricItem } from "@/lib/blocks";

/**
 * 블록 스키마를 화면으로 옮기는 유일한 지점.
 *
 * 모델은 여기서 그릴 수 있는 형태로만 답할 수 있다. 자유 HTML을 받지 않는
 * 이유는 두 가지다. 하나는 주입 위험이고, 다른 하나는 표현이 제각각이면
 * 브리핑 화면으로 읽히지 않기 때문이다.
 */

const card = "rounded-2xl bg-panel/70 p-4 ring-1 ring-white/5 sm:p-5";

export function BlockList({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-3">
      {blocks.map((block, index) => (
        <motion.div
          key={`${block.kind}-${index}`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        >
          <BlockView block={block} />
        </motion.div>
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "headline":
      return (
        <div>
          <h3 className="text-[15px] leading-6 font-bold">{block.title}</h3>
          {block.subtitle ? (
            <p className="mt-1 text-[13px] leading-5 text-muted">{block.subtitle}</p>
          ) : null}
        </div>
      );

    case "metric":
      return (
        <div className={card}>
          {block.title ? <p className="text-[13px] font-semibold">{block.title}</p> : null}
          <p className="mt-1 text-[11px] text-muted">{block.label}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="text-[34px] leading-none font-bold tracking-tight">{block.value}</span>
            {block.badge ? <Badge trend={block.trend}>{block.badge}</Badge> : null}
          </div>
          {block.caption ? (
            <p className="mt-3 text-[11px] leading-4 text-muted">{block.caption}</p>
          ) : null}
        </div>
      );

    case "metricGrid":
      return (
        <div className={card}>
          {block.subtitle ? (
            <p className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
              {block.subtitle}
            </p>
          ) : null}
          {block.title ? <p className="mt-1 text-[15px] font-bold">{block.title}</p> : null}
          <div className="mt-4 grid gap-x-6 gap-y-5 sm:grid-cols-2">
            {block.items.map((item, index) => (
              <MetricCell key={`${item.label}-${index}`} item={item} />
            ))}
          </div>
        </div>
      );

    case "briefing":
      return <BriefingCard block={block} />;

    case "scenario":
      return <ScenarioCard block={block} />;

    case "series":
      return <SeriesChart block={block} />;

    case "table":
      return (
        <div className={card}>
          {block.title ? <p className="text-[13px] font-semibold">{block.title}</p> : null}
          <div className="scroll-x mt-3">
            <table className="w-max min-w-full border-collapse text-left text-[12px]">
              <thead>
                <tr className="text-muted">
                  {block.columns.map((column) => (
                    <th key={column} className="pb-2 pr-4 font-medium whitespace-nowrap">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="border-t border-white/5 align-top">
                    {block.columns.map((_, columnIndex) => (
                      <td key={columnIndex} className="py-2.5 pr-4 leading-5">
                        {row[columnIndex] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {block.caption ? <p className="mt-3 text-[11px] text-muted">{block.caption}</p> : null}
        </div>
      );

    case "bullets":
      return (
        <div className={card}>
          {block.title ? (
            <p
              className={`text-[13px] font-semibold ${
                block.tone === "caution" ? "text-amber-300/90" : ""
              }`}
            >
              {block.title}
            </p>
          ) : null}
          <ul className="mt-2.5 space-y-2">
            {block.items.map((item, index) => (
              <li key={index} className="flex gap-2.5 text-[12px] leading-5 text-[#c7ccd3]">
                <span
                  className={`mt-[7px] h-1 w-1 shrink-0 rounded-full ${
                    block.tone === "caution" ? "bg-amber-300/80" : "bg-mint-400/80"
                  }`}
                />
                {item}
              </li>
            ))}
          </ul>
        </div>
      );

    case "callout":
      return <Callout tone={block.tone} title={block.title} text={block.text} />;

    default:
      return null;
  }
}

/** 목업의 좌우 2단 브리핑 카드. 왼쪽은 이어 읽고, 오른쪽은 칸마다 끊어 읽는다. */
function BriefingCard({ block }: { block: Extract<Block, { kind: "briefing" }> }) {
  return (
    <div>
      <div className="grid overflow-hidden rounded-2xl bg-panel/70 ring-1 ring-white/5 sm:grid-cols-[1.15fr_1fr]">
        <div className="space-y-5 p-5">
          <div>
            <p className="text-[10px] font-semibold tracking-[0.16em] text-muted uppercase">
              {block.label ?? "persona briefing"}
            </p>
            <p className="mt-1.5 text-[14px] font-bold">{block.title}</p>
          </div>
          {block.primary.map((item, index) => (
            <MetricCell key={`${item.label}-${index}`} item={item} />
          ))}
        </div>
        {block.secondary && block.secondary.length > 0 ? (
          <div className="divide-y divide-white/5 border-t border-white/5 sm:border-t-0 sm:border-l">
            {block.secondary.map((item, index) => (
              <div key={`${item.label}-${index}`} className="p-5">
                <MetricCell item={item} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {block.sources && block.sources.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted">출처</span>
          {block.sources.map((source) => (
            <span
              key={source}
              className="rounded-lg bg-panel-soft px-2.5 py-1 text-[11px] text-[#c7ccd3]"
            >
              {source}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 전제를 골라 읽는 추정 카드. 선택된 전제만 강조된다. */
function ScenarioCard({ block }: { block: Extract<Block, { kind: "scenario" }> }) {
  return (
    <div className={card}>
      <p className="text-[13px] font-semibold">{block.title}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-[34px] leading-none font-bold tracking-tight">{block.value}</span>
        {block.badge ? (
          <span className="inline-flex items-center gap-1 rounded-lg bg-panel-soft px-2.5 py-1.5 text-[11px] text-[#d5d9de]">
            <ArrowDown size={12} weight="fill" />
            {block.badge}
          </span>
        ) : null}
      </div>
      {block.caption ? <p className="mt-2.5 text-[11px] text-muted">{block.caption}</p> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {block.options.map((option) => (
          <span
            key={option.label}
            className={`rounded-lg px-3 py-1.5 text-[11px] ${
              option.selected
                ? "bg-mint-400 font-semibold text-ink-950"
                : "bg-panel-soft text-[#c7ccd3]"
            }`}
          >
            {option.label}
          </span>
        ))}
      </div>

      <div className="mt-4 flex h-16 items-end gap-3">
        {block.bars.map((bar, index) => (
          <motion.div
            key={`${bar.label ?? index}-${index}`}
            initial={{ height: 0 }}
            animate={{ height: `${Math.max(12, bar.ratio * 100)}%` }}
            transition={{ duration: 0.45, delay: index * 0.05, ease: "easeOut" }}
            title={bar.label}
            className={`min-w-0 flex-1 rounded-lg ${
              bar.highlight ? "bg-mint-400" : "bg-[#3d4148]"
            }`}
          />
        ))}
      </div>

      {block.notes && block.notes.length > 0 ? (
        <div className="mt-3 space-y-0.5">
          {block.notes.map((note) => (
            <p key={note} className="text-[11px] leading-4 text-muted">
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MetricCell({ item }: { item: MetricItem }) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-[#c7ccd3]">{item.label}</p>
      {item.badge ? (
        <span className="mt-1.5 inline-flex rounded-md bg-[#4a2f2f] px-2 py-0.5 text-[10px] text-[#f3b3b3]">
          {item.badge}
        </span>
      ) : null}
      <p className="mt-1.5 flex items-center gap-2 text-[24px] leading-tight font-bold">
        {item.value}
        {item.trend ? <TrendIcon trend={item.trend} /> : null}
      </p>
      {typeof item.meter === "number" ? <Meter value={item.meter} /> : null}
      {item.caption ? (
        <p className="mt-1.5 text-[11px] leading-4 text-muted">{item.caption}</p>
      ) : null}
    </div>
  );
}

function Meter({ value }: { value: number }) {
  const filled = Math.round(value * 5);
  return (
    <div className="mt-2 flex gap-1">
      {[0, 1, 2, 3, 4].map((index) => (
        <span
          key={index}
          className={`h-1 w-4 rounded-full ${index < filled ? "bg-mint-400" : "bg-white/10"}`}
        />
      ))}
    </div>
  );
}

function SeriesChart({ block }: { block: Extract<Block, { kind: "series" }> }) {
  const values = block.points.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  // 값 폭이 좁은 인구 시계열도 차이가 보이도록 최저값 기준으로 눌러 그린다.
  const floor = min - (max - min) * 0.6 || 0;
  const span = max - floor || 1;
  const format = new Intl.NumberFormat("ko-KR");

  return (
    <div className={card}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-semibold">{block.title}</p>
        {block.unit ? <span className="text-[11px] text-muted">단위: {block.unit}</span> : null}
      </div>
      <div className="mt-4 flex h-24 items-end gap-1 sm:h-28 sm:gap-2">
        {block.points.map((point, index) => (
          <motion.div
            key={`${point.label}-${index}`}
            initial={{ height: 0 }}
            animate={{ height: `${Math.max(8, ((point.value - floor) / span) * 100)}%` }}
            transition={{ duration: 0.5, delay: index * 0.04, ease: "easeOut" }}
            title={`${point.label} · ${format.format(point.value)}${block.unit ?? ""}`}
            className={`min-w-0 flex-1 rounded-lg ${
              point.highlight ? "bg-mint-400" : "bg-[#3d4148]"
            }`}
          />
        ))}
      </div>
      <div className="mt-2 flex gap-1 text-[9px] text-muted sm:gap-2 sm:text-[10px]">
        {block.points.map((point, index) => (
          <span key={`${point.label}-label-${index}`} className="min-w-0 flex-1 truncate text-center">
            {point.label}
          </span>
        ))}
      </div>
      {block.caption ? <p className="mt-3 text-[11px] text-muted">{block.caption}</p> : null}
    </div>
  );
}

function Badge({ children, trend }: { children: React.ReactNode; trend?: MetricItem["trend"] }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-lg bg-panel-soft px-2.5 py-1 text-[11px] text-[#d5d9de]">
      {trend ? <TrendIcon trend={trend} /> : null}
      {children}
    </span>
  );
}

function TrendIcon({ trend }: { trend: NonNullable<MetricItem["trend"]> }) {
  if (trend === "up") return <ArrowUp size={13} weight="bold" className="text-mint-400" />;
  if (trend === "down") return <ArrowDown size={13} weight="bold" className="text-rose-300" />;
  return <Minus size={13} weight="bold" className="text-muted" />;
}

export function Callout({
  tone,
  title,
  text
}: {
  tone: "info" | "warn" | "danger";
  title?: string;
  text: string;
}) {
  const palette = {
    info: "border-sky-400/25 bg-sky-400/5 text-sky-200",
    warn: "border-amber-400/25 bg-amber-400/5 text-amber-200",
    danger: "border-rose-400/25 bg-rose-400/5 text-rose-200"
  }[tone];
  const Icon = tone === "info" ? Info : tone === "warn" ? Warning : WarningOctagon;
  return (
    <div className={`flex gap-3 rounded-2xl border px-4 py-3.5 ${palette}`}>
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div>
        {title ? <p className="text-[12.5px] font-semibold">{title}</p> : null}
        <p className="mt-0.5 text-[12px] leading-5 opacity-85">{text}</p>
      </div>
    </div>
  );
}
