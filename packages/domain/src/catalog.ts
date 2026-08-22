/**
 * Semantic dataset catalog.
 *
 * The tools in this project each answer one question shape. That is safe but it
 * forces the caller to already know which dataset can answer a question, what
 * unit it is in, which years it covers, and whether two datasets may legally be
 * joined. This module encodes that knowledge as data so an AI agent can
 * *discover* it instead of having it hard-coded into a prompt.
 *
 * Nothing here contains observations. Row counts, year ranges and region
 * coverage are deliberately NOT stored here: they are measured live from the
 * repository, because a stale hand-written coverage claim is exactly the kind of
 * unsourced assertion the rest of the system refuses to make.
 */

/** How one row of a dataset is identified. Two datasets can only be joined when their grains are reconcilable. */
export type DatasetGrain =
  | "region_year"
  | "region_year_tax_category"
  | "region_policy"
  | "council_meeting_record"
  | "press_release"
  | "council_bill"
  | "document_chunk";

/**
 * What a measure means. `evidenceRole` is the load-bearing field: narrative
 * material may contextualize an answer but must never be treated as an observed
 * statistic.
 */
export type EvidenceRole = "observed_fact" | "narrative_context_only";

/**
 * The claims a dataset is and is not allowed to support.
 *
 * `usageRules` already constrained *how* a dataset may be queried, but the
 * question a reader actually has is "given this document, what am I entitled to
 * conclude?". Leaving that to prose in a limitations list meant the boundary
 * existed only in the reader's head: a press release stating a target figure
 * and a statistical yearbook stating an observed figure both render as a number
 * with a citation, and nothing on screen distinguishes a plan from a fact.
 *
 * Declaring it as data lets the same boundary be shown next to every number,
 * returned by `describe_dataset`, and asserted in tests.
 */
export interface EvidenceContract {
  role: EvidenceRole;
  /** Claims this dataset can support on its own. */
  canClaim: string[];
  /** Claims this dataset must never be cited for, and why. */
  cannotClaim: string[];
  /**
   * Where a claim in `cannotClaim` has to come from instead. Without this the
   * contract only tells a user they are stuck.
   */
  insteadUse: string | null;
}

export interface DatasetMeasure {
  name: string;
  /** Human-facing label used when the agent renders a number. */
  label: string;
  /** Canonical unit after normalization. `null` for non-numeric datasets. */
  unit: string | null;
  /**
   * The precise real-world quantity. Two measures with the same unit but
   * different semantics (collected vs. levied tax) must not be compared.
   */
  semantics: string;
  /** Why a naive comparison of this measure across rows can be wrong. */
  comparabilityCaveat?: string;
}

export interface DatasetDimension {
  name: string;
  label: string;
  /** Whether this dimension is usable as a join key against other datasets. */
  joinKey: boolean;
  description: string;
}

export interface DatasetToolBinding {
  /** MCP tool that can read this dataset. */
  tool: string;
  /** What question shape this tool/dataset pair answers. */
  answers: string;
  /**
   * Arguments the agent must supply, beyond optional filters. Used by the
   * planner to check whether it has enough information to call the tool.
   */
  requiredArguments: string[];
}

export interface DatasetDefinition {
  datasetId: string;
  title: string;
  /** One paragraph an agent can read to decide whether this dataset is relevant. */
  description: string;
  grain: DatasetGrain;
  evidenceRole: EvidenceRole;
  /** What this dataset may and may not be cited for. */
  evidenceContract: EvidenceContract;
  measures: DatasetMeasure[];
  dimensions: DatasetDimension[];
  /** Query terms a user might use that should match this dataset. */
  keywords: string[];
  tools: DatasetToolBinding[];
  /** Rules that constrain how this dataset may be used in an answer. */
  usageRules: string[];
}

export interface DatasetRelationship {
  from: string;
  to: string;
  /** Dimension names present on both sides. */
  joinKeys: string[];
  /**
   * What a join buys you. Kept explicit so the agent can explain *why* it
   * combined two datasets rather than asserting an unexplained correlation.
   */
  rationale: string;
  /**
   * Conditions that must hold for the join to be meaningful. If the agent
   * cannot verify these it must degrade to reporting both series separately.
   */
  caveats: string[];
}

const REGION_DIMENSION: DatasetDimension = {
  name: "region",
  label: "행정구역",
  joinKey: true,
  description:
    "dim_region으로 정규화된 경상북도 시군. 원본 표기가 달라도 같은 region_id로 모인다."
};

const YEAR_DIMENSION: DatasetDimension = {
  name: "year",
  label: "연도",
  joinKey: true,
  description: "관측 연도. 회계연도와 기준일 정밀도는 데이터셋마다 다르다."
};

export const DATASET_CATALOG: readonly DatasetDefinition[] = [
  {
    datasetId: "population_observation",
    title: "시군별 인구 관측",
    description:
      "경상북도 시군의 연도별 총인구. 주민등록 스냅샷, 통계연보 인구, 지방세 신고 기준 인구처럼 측정 기준이 서로 다른 값이 함께 들어 있으며, 각 행은 자신의 measurementBasis를 보존한다.",
    grain: "region_year",
    evidenceRole: "observed_fact",
    evidenceContract: {
      role: "observed_fact",
      canClaim: [
        "특정 시군의 특정 연도 총인구가 얼마였는지",
        "measurementBasis가 동일한 두 시점 사이의 인구 증감과 증감률"
      ],
      cannotClaim: [
        "인구가 줄어든 원인이나 특정 정책의 효과 (관측값일 뿐 인과를 담지 않는다)",
        "측정 기준이 다른 두 값을 이어 붙인 추세 (정의 변화를 인구 변화로 오독하게 된다)",
        "장래 인구 전망 (이 데이터셋은 과거 관측만 담는다)"
      ],
      insteadUse:
        "원인·효과는 별도의 정책 평가 자료가, 장래 전망은 통계청 장래인구추계가 필요하다."
    },
    measures: [
      {
        name: "populationTotal",
        label: "총인구",
        unit: "명",
        semantics: "해당 기준일 시점의 총인구 수",
        comparabilityCaveat:
          "measurementBasis가 다른 값끼리 증감률을 계산하면 실제 인구 변화가 아니라 정의 변화를 측정하게 된다."
      }
    ],
    dimensions: [
      REGION_DIMENSION,
      YEAR_DIMENSION,
      {
        name: "measurementBasis",
        label: "측정 기준",
        joinKey: false,
        description:
          "resident_registration_snapshot / annual_statistical_population / tax_year_reported_population 중 하나."
      }
    ],
    keywords: [
      "인구",
      "총인구",
      "인구수",
      "주민등록",
      "인구감소",
      "인구변화",
      "population",
      "지방소멸",
      "인구추이"
    ],
    tools: [
      {
        tool: "get_population_trend",
        answers: "특정 시군의 기간별 인구 시계열과 증감률",
        requiredArguments: ["region", "startYear", "endYear"]
      }
    ],
    usageRules: [
      "서로 다른 measurementBasis를 한 시계열로 이어 붙이지 않는다.",
      "증감률은 동일 기준으로 측정된 두 점 이상이 있을 때만 계산한다."
    ]
  },
  {
    datasetId: "local_tax_revenue",
    title: "시군별 지방세 세수",
    description:
      "경상북도 시군의 회계연도별 지방세 세수. 징수 실적, 신고 기준 총세액, 통계연보 징수액 등 원천마다 금액의 의미(amountSemantics)와 원 단위(원/천원)가 달라 정규화 후에도 각 행이 자신의 의미를 보존한다.",
    grain: "region_year_tax_category",
    evidenceRole: "observed_fact",
    evidenceContract: {
      role: "observed_fact",
      canClaim: [
        "특정 시군·연도의 지방세 세수 금액",
        "amountSemantics와 회계 기준이 동일한 두 시점 사이의 세수 증감"
      ],
      cannotClaim: [
        "재정자립도나 재정 건전성 (세수는 세입의 일부일 뿐 세출과 이전재원을 담지 않는다)",
        "징수액과 부과액처럼 의미가 다른 값의 비교",
        "주민 1인당 세부담 (인구와 결합해도 납세자 수가 아니라 거주자 수로 나눈 값이다)"
      ],
      insteadUse:
        "재정 상태는 지방재정 결산 자료가, 세부담은 납세자 통계가 필요하다."
    },
    measures: [
      {
        name: "revenueAmountWon",
        label: "세수액",
        unit: "원",
        semantics: "해당 회계연도 지방세 금액(원 단위로 정규화됨)",
        comparabilityCaveat:
          "amountSemantics(collected_amount, reported_total_tax_burden 등)와 accountingBasis(settlement/budget)가 다르면 같은 '세수'가 아니다."
      }
    ],
    dimensions: [
      REGION_DIMENSION,
      { ...YEAR_DIMENSION, label: "회계연도" },
      {
        name: "taxCategory",
        label: "세목",
        joinKey: false,
        description: "합계, 취득세, 지방소득세 등. 기본값은 합계."
      },
      {
        name: "amountSemantics",
        label: "금액 의미",
        joinKey: false,
        description:
          "collected_amount / payment_amount / reported_total_tax_burden 중 하나."
      }
    ],
    keywords: [
      "지방세",
      "세수",
      "세입",
      "재정",
      "세금",
      "징수",
      "취득세",
      "지방소득세",
      "tax",
      "재정자립"
    ],
    tools: [
      {
        tool: "get_local_tax_revenue_trend",
        answers: "특정 시군의 기간별 지방세 세수 시계열과 증감률",
        requiredArguments: ["region", "startYear", "endYear"]
      }
    ],
    usageRules: [
      "amountSemantics가 다른 값끼리 증감률을 계산하지 않는다.",
      "천원 단위 원천은 이미 원 단위로 환산되어 있으므로 다시 곱하지 않는다."
    ]
  },
  {
    datasetId: "policy_program",
    title: "정책·지원사업 안내",
    description:
      "연령, 업종, 창업 단계 같은 조건이 구조화된 정책 프로그램. 조건에 부합할 가능성이 있는 사업을 찾아 주는 안내용이며 신청 자격을 판정하지 않는다. 자격 판정 권한은 소관 기관에 있고 최종 근거는 개별 사업 공고문이다. 현재 적재된 원천은 도정 업무계획 계열 문서라 개별 공고의 접수 기간·예산·세부 요건을 담지 않는다.",
    grain: "region_policy",
    evidenceRole: "observed_fact",
    evidenceContract: {
      role: "observed_fact",
      canClaim: [
        "문서에 기재된 정책·지원사업의 명시적 조건 문구"
      ],
      cannotClaim: [
        "특정 신청자가 실제로 자격을 갖췄는지 (판정 권한은 소관 기관에 있다)",
        "현재 접수 중인지, 예산이 남아 있는지",
        "기재되지 않은 조건이 없다는 것 (문서에 없는 조건이 공고문에는 있을 수 있다)"
      ],
      insteadUse:
        "실제 신청 자격과 접수 여부는 해당 사업의 공식 공고문으로 확인해야 한다."
    },
    measures: [],
    dimensions: [
      REGION_DIMENSION,
      {
        name: "age",
        label: "연령 조건",
        joinKey: false,
        description: "ageMin/ageMax로 표현된 신청 가능 연령 범위."
      },
      {
        name: "industries",
        label: "업종",
        joinKey: false,
        description: "스마트팜, 제조 등 대상 업종 목록."
      },
      {
        name: "stages",
        label: "창업 단계",
        joinKey: false,
        description: "예비창업, 초기창업 등."
      }
    ],
    keywords: [
      "정책",
      "지원사업",
      "보조금",
      "창업",
      "지원금",
      "자격",
      "신청",
      "공모",
      "policy",
      "스마트팜",
      "청년정책"
    ],
    tools: [
      {
        tool: "search_policies",
        answers: "신청자 조건에 부합하는 정책과 미충족 조건",
        // age is not optional in the tool's schema: eligibility cannot be
        // judged without it, so a planner must be told to obtain it rather
        // than discovering the requirement as a runtime rejection.
        requiredArguments: ["region", "age", "query"]
      }
    ],
    usageRules: [
      "이 도구는 신청 자격을 판정하지 않는다. 결과는 '확인해 볼 만한 사업' 목록이며 최종 자격은 공고문으로만 확인된다.",
      "부합 이유와 미충족 조건을 분리해서 제시하고, 어느 쪽도 판정으로 서술하지 않는다.",
      "업무계획 계열 문서는 정책 방향이므로 개별 사업의 자격 근거로 인용하지 않는다."
    ]
  },
  {
    datasetId: "council_record",
    title: "도의회 회의 기록",
    description:
      "경상북도의회 회의록에서 추출한 발언·안건 기록. 특정 주제가 시간에 따라 어떻게 논의되었는지 추적하는 데 쓴다.",
    grain: "council_meeting_record",
    evidenceRole: "narrative_context_only",
    evidenceContract: {
      role: "narrative_context_only",
      canClaim: [
        "특정 사안이 언제 어느 회의에서 논의되었는지",
        "누가 어떤 발언을 했는지 (발언 원문 인용)"
      ],
      cannotClaim: [
        "회의에서 인용된 수치의 사실 여부 (발언은 발언일 뿐 관측이 아니다)",
        "논의 결과가 실제로 집행되었는지",
        "발언 빈도로 판단한 의원의 성과나 관심도"
      ],
      insteadUse:
        "수치는 통계 데이터셋으로, 집행 여부는 결산·성과 자료로 확인해야 한다."
    },
    measures: [],
    dimensions: [
      REGION_DIMENSION,
      {
        name: "meetingDate",
        label: "회의일",
        joinKey: false,
        description: "회의 개최일. 연도 단위 필터링에 사용한다."
      },
      {
        name: "council",
        label: "의회",
        joinKey: false,
        description: "경상북도의회 등 의회명."
      }
    ],
    keywords: [
      "의회",
      "회의록",
      "도의회",
      "발언",
      "안건",
      "심의",
      "council",
      "논의"
    ],
    tools: [
      {
        tool: "search_council_records",
        answers: "특정 주제에 대한 의회 논의 기록과 시간에 따른 변화",
        requiredArguments: ["query"]
      }
    ],
    usageRules: [
      "회의 발언은 사실 관측이 아니라 논의 정황이다. 통계 주장의 근거로 쓰지 않는다."
    ]
  },
  {
    datasetId: "press_release",
    title: "경상북도 보도자료",
    description:
      "경상북도가 발행한 보도자료 전문. 정책의 발표 시점과 도정의 서술을 확인하는 데 쓰며, 수치 주장의 근거로는 쓸 수 없다.",
    grain: "press_release",
    evidenceRole: "narrative_context_only",
    evidenceContract: {
      role: "narrative_context_only",
      canClaim: [
        "도가 특정 시점에 무엇을 발표했는지",
        "발표된 계획의 내용과 발표일"
      ],
      cannotClaim: [
        "본문에 실린 수치 (발표 시점의 계획치·목표치이며 관측 통계가 아니다)",
        "발표한 사업이 실제로 집행되었거나 성과를 냈는지",
        "본문에 시군 이름이 나왔다는 이유로 그 시군의 사업이라는 것"
      ],
      insteadUse:
        "수치 검증은 verify_claim_with_data와 통계 데이터셋이, 집행 결과는 별도 통계가 필요하다."
    },
    measures: [],
    dimensions: [
      REGION_DIMENSION,
      {
        name: "publishedDate",
        label: "발행일",
        joinKey: false,
        description: "보도자료 발행일."
      },
      {
        name: "department",
        label: "담당부서",
        joinKey: false,
        description: "보도자료를 낸 실·국·과."
      }
    ],
    keywords: [
      "보도자료",
      "발표",
      "도정",
      "홍보",
      "press",
      "브리핑",
      "announcement",
      "정책발표"
    ],
    tools: [
      {
        tool: "search_press_releases",
        answers: "특정 주제에 대한 도의 공식 발표와 시점",
        requiredArguments: ["query"]
      }
    ],
    usageRules: [
      "보도자료의 수치는 재인용이므로 원천 통계로 교차 확인하기 전에는 사실로 제시하지 않는다."
    ]
  },
  {
    datasetId: "council_bill",
    title: "도의원 발의 의안",
    description:
      "경상북도의회 의원별 대표발의·공동발의 의안과 처리 결과. 특정 의원 또는 특정 주제의 입법 활동을 추적한다.",
    grain: "council_bill",
    evidenceRole: "narrative_context_only",
    evidenceContract: {
      role: "narrative_context_only",
      canClaim: [
        "어떤 의안이 언제 발의되었고 누가 대표·공동발의했는지",
        "의안의 처리 결과 (원안가결 등 의회 내 절차 결과)"
      ],
      cannotClaim: [
        "선거 공약의 이행 여부 (경상북도의회는 공약을 공개하지 않는다)",
        "발의 건수로 판단한 의정활동의 양이나 질 (예산 심의·행정사무감사는 포함되지 않는다)",
        "가결된 조례가 실제로 집행되었는지"
      ],
      insteadUse:
        "공약 원문은 중앙선거관리위원회 자료가, 집행 여부는 결산 자료가 필요하다."
    },
    measures: [
      {
        name: "leadBillCount",
        label: "대표발의 건수",
        unit: "건",
        semantics: "해당 의원이 대표발의한 의안 수",
        comparabilityCaveat:
          "수집 시점까지의 누적이며 임기 길이가 다른 의원 간 단순 비교는 오도할 수 있다."
      }
    ],
    dimensions: [
      {
        name: "member",
        label: "의원",
        joinKey: false,
        description: "도의원 이름."
      },
      {
        name: "committee",
        label: "소관 위원회",
        joinKey: false,
        description: "의안을 심사한 위원회."
      },
      {
        name: "proposedDate",
        label: "발의일",
        joinKey: false,
        description: "의안 발의일."
      }
    ],
    keywords: [
      "의안",
      "발의",
      "조례",
      "의원",
      "입법",
      "대표발의",
      "공동발의",
      "bill",
      "위원회"
    ],
    tools: [
      {
        tool: "search_member_bills",
        answers: "의원별 또는 주제별 발의 의안과 처리 결과",
        // The tool itself refuses unless member or query is present. Declaring
        // [] told planners the call was free-form and produced an empty call
        // that the tool then rejected, so the catalog now states the weaker of
        // the two requirements it can express.
        requiredArguments: ["query"]
      }
    ],
    usageRules: [
      "발의 건수는 활동량 지표일 뿐 입법 성과의 품질을 뜻하지 않는다."
    ]
  },
  {
    datasetId: "document_chunk",
    title: "정책 문서 본문 (PDF)",
    description:
      "정책 계획서·공고문 PDF에서 페이지 단위로 추출한 본문. 모든 조각은 원본 문서와 페이지 번호를 보존하므로 인용 위치를 정확히 되짚을 수 있다.",
    grain: "document_chunk",
    evidenceRole: "narrative_context_only",
    evidenceContract: {
      role: "narrative_context_only",
      canClaim: [
        "공식 문서의 특정 페이지에 어떤 문장이 실려 있는지 (페이지 단위 원문 인용)"
      ],
      cannotClaim: [
        "본문에 실린 수치를 관측 통계로 사용하는 것",
        "업무계획에 적힌 방향을 개별 사업의 신청 자격으로 사용하는 것",
        "검색되지 않았다는 이유로 해당 내용이 문서에 없다는 것 (검색은 lexical이라 동의어 recall을 보장하지 않는다)"
      ],
      insteadUse:
        "수치는 통계 데이터셋이, 신청 자격은 공식 공고문이 근거가 되어야 한다."
    },
    measures: [],
    dimensions: [
      REGION_DIMENSION,
      {
        name: "documentType",
        label: "문서 유형",
        joinKey: false,
        description: "계획서, 공고 등."
      },
      {
        name: "page",
        label: "페이지",
        joinKey: false,
        description: "원본 PDF의 페이지 번호. 인용 위치 확인에 쓴다."
      }
    ],
    keywords: [
      "문서",
      "계획",
      "보고서",
      "공고",
      "pdf",
      "본문",
      "원문",
      "document"
    ],
    tools: [
      {
        tool: "search_documents",
        answers: "주제어로 찾은 공식 문서의 페이지 단위 본문",
        requiredArguments: ["query"]
      },
      {
        tool: "get_source_context",
        answers: "특정 source_id의 원문 위치와 인용 맥락",
        requiredArguments: ["sourceIds"]
      }
    ],
    usageRules: [
      "본문 인용은 반드시 페이지 번호와 함께 제시한다.",
      "추출 품질이 낮다고 표시된 문서는 검색 대상에서 제외된다."
    ]
  }
] as const;

export const DATASET_RELATIONSHIPS: readonly DatasetRelationship[] = [
  {
    from: "population_observation",
    to: "local_tax_revenue",
    joinKeys: ["region", "year"],
    rationale:
      "인구가 줄면서 세수가 늘어나는 시군을 찾는 등 인구 구조와 재정 여력을 함께 보는 분석에 쓴다.",
    caveats: [
      "인구는 기준일 스냅샷이고 지방세는 회계연도 누계라 같은 연도라도 관측 기간이 정확히 일치하지 않는다.",
      "두 시계열 모두 각자의 measurementBasis / amountSemantics가 일정할 때만 증감률을 비교한다."
    ]
  },
  {
    from: "population_observation",
    to: "policy_program",
    joinKeys: ["region"],
    rationale:
      "인구 감소가 큰 시군에 어떤 정책이 배치되어 있는지 지역 단위로 대조한다.",
    caveats: [
      "정책은 연도 grain이 없으므로 특정 연도의 인구 변화와 인과적으로 연결하지 않는다."
    ]
  },
  {
    from: "local_tax_revenue",
    to: "policy_program",
    joinKeys: ["region"],
    rationale: "재정 여건과 지원사업 배치를 지역 단위로 대조한다.",
    caveats: ["예산 규모와 정책 수 사이에 인과를 주장하지 않는다."]
  },
  {
    from: "population_observation",
    to: "council_record",
    joinKeys: ["region"],
    rationale:
      "인구 지표의 변화가 의회에서 어떻게 논의되었는지 정황을 붙인다.",
    caveats: [
      "회의 기록은 narrative_context_only이므로 인구 수치의 근거가 될 수 없다."
    ]
  },
  {
    from: "population_observation",
    to: "press_release",
    joinKeys: ["region"],
    rationale: "인구 변화 시점 전후의 도 정책 발표를 시간순으로 대조한다.",
    caveats: [
      "보도자료는 narrative_context_only이며 발표 시점이 정책 시행 시점과 다를 수 있다."
    ]
  },
  {
    from: "policy_program",
    to: "press_release",
    joinKeys: ["region"],
    rationale: "구조화된 정책 조건과 해당 정책의 공식 발표문을 연결한다.",
    caveats: ["보도자료 문구를 자격 조건으로 사용하지 않는다."]
  },
  {
    from: "council_record",
    to: "council_bill",
    joinKeys: [],
    rationale: "의회 논의와 실제 발의된 의안을 주제 단위로 대조한다.",
    caveats: [
      "공통 조인 키가 없어 주제어 기반 대조만 가능하며 자동 연결을 주장하지 않는다."
    ]
  }
] as const;

const CATALOG_BY_ID = new Map(
  DATASET_CATALOG.map((dataset) => [dataset.datasetId, dataset])
);

export function getDatasetDefinition(
  datasetId: string
): DatasetDefinition | undefined {
  return CATALOG_BY_ID.get(datasetId);
}

export function listDatasetIds(): string[] {
  return DATASET_CATALOG.map((dataset) => dataset.datasetId);
}

/**
 * Flattens a dataset into the text an agent's query is matched against. Keeping
 * this in one place means search and explanation stay consistent: whatever text
 * caused a match is text we can show as the reason.
 */
export function datasetSearchText(dataset: DatasetDefinition): string {
  return [
    dataset.title,
    dataset.description,
    ...dataset.keywords,
    ...dataset.measures.flatMap((measure) => [measure.label, measure.semantics]),
    ...dataset.dimensions.map((dimension) => dimension.label),
    ...dataset.tools.map((binding) => binding.answers)
  ].join(" ");
}

/**
 * The curated terms that are allowed to *justify* selecting a dataset.
 *
 * Deliberately narrower than {@link datasetSearchText}: free-text descriptions
 * are useful for ordering candidates but contain common words ("주제", "기준")
 * that would let an unrelated question match. Relevance is therefore gated on
 * this controlled vocabulary while ranking still uses the fuller text.
 */
export function datasetVocabulary(dataset: DatasetDefinition): string[] {
  return [
    dataset.title,
    ...dataset.keywords,
    ...dataset.measures.map((measure) => measure.label),
    ...dataset.dimensions.map((dimension) => dimension.label)
  ]
    .flatMap((entry) => entry.split(/\s+/u))
    .map((term) => term.normalize("NFC").toLowerCase())
    .filter((term) => term.length >= 2);
}

/**
 * Whether a query is about this dataset at all.
 *
 * Matching is bidirectional-substring because Korean is agglutinative: the
 * query word "인구는" carries a particle and will never equal the vocabulary
 * term "인구", but it contains it. Requiring a whole query *word* (not a
 * generated character bigram) to overlap the controlled vocabulary is what
 * stops nonsense queries from silently selecting an arbitrary dataset.
 */
/**
 * Terms that name *where* rather than *what*.
 *
 * Every dataset in this catalog is about Gyeongbuk, so a place name carries no
 * signal about which dataset answers a question. Left in the gate, "경상북도의
 * 국세 납부 실적" matches the press-release dataset on the province name alone
 * and the agent answers an out-of-scope question from unrelated material.
 * They still contribute to ranking — they just cannot, by themselves, make a
 * dataset relevant.
 */
const GEOGRAPHIC_TERMS = new Set([
  "경상북도",
  "경북",
  "행정구역",
  "시군",
  "시군별",
  "지역",
  "지자체",
  "기초자치단체",
  "광역자치단체"
]);

function isGeographicTerm(term: string): boolean {
  if (GEOGRAPHIC_TERMS.has(term)) return true;
  // Bare 시/군 names such as 포항시 or 울진군; two characters plus the suffix.
  return /^[\p{Script=Hangul}]{2,4}(?:시|군|읍|면|동)$/u.test(term);
}

export function isDatasetRelevant(
  dataset: DatasetDefinition,
  query: string
): boolean {
  const words = query
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2);
  if (words.length === 0) return false;
  const vocabulary = datasetVocabulary(dataset).filter(
    (term) => !isGeographicTerm(term)
  );
  return words.some((word) =>
    vocabulary.some((term) => word.includes(term) || term.includes(word))
  );
}

/** Relationships touching a dataset, normalized so `from` is always the queried dataset. */
export function relationshipsFor(datasetId: string): DatasetRelationship[] {
  return DATASET_RELATIONSHIPS.flatMap((relationship) => {
    if (relationship.from === datasetId) return [relationship];
    if (relationship.to === datasetId) {
      return [
        {
          ...relationship,
          from: relationship.to,
          to: relationship.from
        }
      ];
    }
    return [];
  });
}

/**
 * Whether two datasets may be combined, and under what conditions.
 *
 * Returns `null` when no relationship is declared. Callers must treat that as
 * "do not join" rather than "join without caveats" — an undeclared join is an
 * unreviewed one.
 */
export function joinability(
  fromDatasetId: string,
  toDatasetId: string
): DatasetRelationship | null {
  return (
    relationshipsFor(fromDatasetId).find(
      (relationship) => relationship.to === toDatasetId
    ) ?? null
  );
}
