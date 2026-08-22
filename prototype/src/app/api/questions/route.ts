import { NextResponse } from "next/server";
import { fetchQuestions } from "@/lib/agent";
import { loadRepoEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 대표 질문 목록. 시작점일 뿐이며 정답 경로가 심어져 있지 않다. */
export async function GET(): Promise<NextResponse> {
  loadRepoEnv();
  return NextResponse.json({ questions: await fetchQuestions() });
}
