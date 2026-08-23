import Link from "next/link";
// 서버 컴포넌트에서는 컨텍스트를 쓰지 않는 ssr 진입점을 써야 한다.
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr";

export const metadata = { title: "가이드 & FAQ · G-BAP" };

const SECTIONS = [
  {
    title: "이 화면은 무엇을 보여주나요",
    body: "질문을 받으면 MCP 에이전트가 데이터 카탈로그를 검색해 후보 데이터셋을 고르고, 허용된 도구만 호출해 근거를 모읍니다. 화면에 보이는 카드는 그렇게 모인 값만 옮겨 그린 것입니다."
  },
  {
    title: "모델이 답을 만드나요",
    body: "아닙니다. 모델은 두 곳에서만 쓰입니다. 하나는 어떤 도구를 부를지 계획하는 단계이고, 다른 하나는 이미 확보된 근거를 카드 형태로 배치하는 단계입니다. 카드에 들어가는 수치는 도구 응답에 있던 값 그대로이며, 화면 스키마를 벗어난 응답은 버리고 결정적 렌더러로 대체합니다."
  },
  {
    title: "답을 못 하는 질문도 있나요",
    body: "있습니다. 적재된 행이 없거나 보유 범위 밖이면 그렇다고 말합니다. 비어 있는 데이터셋은 다른 자료로 답하더라도 별도로 알립니다. 없는 근거로 답을 만드는 쪽이 훨씬 위험하기 때문입니다."
  },
  {
    title: "에이전트 경로는 왜 보여주나요",
    body: "카탈로그 후보, 실제 호출된 도구와 인자, 안전 경계가 막은 호출, 비어 있던 데이터셋을 전부 펼쳐 볼 수 있습니다. 결론만으로는 이 결과가 검증 가능한지 알 수 없습니다."
  },
  {
    title: "내 정보는 저장되나요",
    body: "지역·나이·관심분야는 브라우저 세션에만 있고, 질문을 만들 때 맥락 문자열로만 붙습니다. 대화 기록도 브라우저 로컬 저장소에만 남으며 사이드바의 '기록 삭제하기'로 지울 수 있습니다."
  }
];

export default function GuidePage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-16">
      <Link
        href="/chat"
        className="inline-flex items-center gap-2 text-[13px] text-muted transition-colors hover:text-white"
      >
        <ArrowLeft size={15} />
        대화로 돌아가기
      </Link>
      <h1 className="mt-6 text-[28px] font-bold tracking-tight">가이드 &amp; FAQ</h1>
      <div className="mt-8 space-y-3">
        {SECTIONS.map((section) => (
          <section key={section.title} className="rounded-2xl bg-panel/60 p-5 ring-1 ring-white/5">
            <h2 className="text-[14px] font-bold">{section.title}</h2>
            <p className="mt-2 text-[13px] leading-6 text-[#c7ccd3]">{section.body}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
