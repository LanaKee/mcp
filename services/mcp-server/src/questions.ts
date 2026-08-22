/**
 * Starting points for the web demo.
 *
 * These are only questions. They carry no tool, no dataset, no year window and
 * no answer shape: the agent works all of that out at request time from the
 * catalog, exactly as it does for a question the user types. An earlier version
 * branched on the id and ran a pre-written sequence per question, which meant
 * the demo proved nothing about the system's ability to route an unseen
 * question.
 *
 * Each one is chosen to expose a different behaviour, and each has been checked
 * against the loaded data so the demo never depends on rows that are not there:
 *
 * - `population-tax` combines two datasets over a declared join and carries the
 *   comparability caveats through.
 * - `uljin-population` asks for a window wider than that region actually holds,
 *   so the agent declines and says what it does have.
 * - `press-population` and `council-population` reach different retrieval tools
 *   from the same topic word.
 * - `youth-policy` names a dataset that exists but is empty, which the agent
 *   discloses while answering from another source.
 * - `mars-water` is out of scope entirely and gets no candidates at all.
 */
export const representativeQuestions = [
  {
    id: "population-tax",
    question: "포항시는 2018년부터 2024년까지 인구는 줄었는데 지방세 세수는 늘었나?"
  },
  {
    id: "uljin-population",
    question: "울진군의 2015년부터 2024년까지 인구 추세를 알려줘"
  },
  {
    id: "press-population",
    question: "경상북도 인구 관련 보도자료를 찾아줘"
  },
  {
    id: "council-population",
    question: "도의회에서 인구 관련 의안을 찾아줘"
  },
  {
    id: "youth-policy",
    question: "경상북도 청년 정책 지원 사업 알려줘"
  },
  {
    id: "mars-water",
    question: "화성에서 물을 어떻게 구하나요?"
  }
] as const;
