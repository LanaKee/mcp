export type PdfContentClassification =
  | "extracted_ok"
  | "mojibake_suspected"
  | "unusable_for_retrieval"
  | "empty";

const ADMINISTRATIVE_TERMS = [
  "경상북도",
  "경북",
  "사업",
  "추진",
  "지원",
  "계획",
  "도민",
  "예산",
  "정책",
  "운영",
  "조성",
  "확대",
  "강화",
  "개선",
  "지역",
  "청년",
  "농업",
  "산업",
  "복지",
  "교육",
  "문화",
  "관광",
  "안전",
  "환경",
  "경제",
  "일자리",
  "인구",
  "지방",
  "주민",
  "위원회",
  "의원",
  "의회",
  "감사",
  "질의",
  "답변",
  "조례",
  "회의",
  "보고",
  "업무",
  "현황",
  "시행",
  "관리",
  "구축",
  "활성화",
  "지속",
  "개발",
  "공공",
  "기관",
  "대상",
  "내용",
  "주요",
  "목표",
  "성과",
  "협력",
  "선정",
  "신청",
  "제공",
  "기반",
  "대응",
  "분야",
  "실시",
  "수립",
  "진행",
  "필요",
  "마련",
  "확보",
  "통합",
  "체계",
  "사업비",
  "억원",
  "백만원"
] as const;

const BIGRAM_SEED_WORDS = [
  ...ADMINISTRATIVE_TERMS,
  "그리고",
  "하지만",
  "위하여",
  "따라서",
  "대한",
  "통하여",
  "합니다",
  "됩니다",
  "있습니다",
  "입니다",
  "수",
  "및",
  "등"
];

const VALID_HANGUL_BIGRAMS = new Set(
  BIGRAM_SEED_WORDS.flatMap((word) => {
    const characters = [...word];
    return characters
      .slice(0, -1)
      .map((character, index) => `${character}${characters[index + 1]}`);
  })
);

const RARE_JONGSEONG = new Set([
  2, 3, 7, 11, 12, 17, 18, 20, 22, 23, 24, 25, 26, 27
]);
const RARE_JUNGSEONG = new Set([3, 7, 12, 13, 16, 17, 18, 19, 20]);

export interface KoreanTextPlausibility {
  nonWhitespaceCharacterCount: number;
  hangulCharacterCount: number;
  hangulRatio: number;
  administrativeTermHitCount: number;
  administrativeTermHitRate: number;
  validHangulBigramRatio: number;
  rareHangulSyllableRatio: number;
  particleTokenRatio: number;
  whitespaceBoundaryRatio: number;
  digitPunctuationRatio: number;
  mojibakeScore: number;
  signals: string[];
}

function bounded(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rareHangulSyllable(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || codePoint < 0xac00 || codePoint > 0xd7a3) {
    return false;
  }
  const offset = codePoint - 0xac00;
  const jungseong = Math.floor((offset % 588) / 28);
  const jongseong = offset % 28;
  return RARE_JUNGSEONG.has(jungseong) || RARE_JONGSEONG.has(jongseong);
}

export function scoreKoreanTextPlausibility(
  input: string
): KoreanTextPlausibility {
  const text = input.normalize("NFC");
  const characters = [...text];
  const nonWhitespace = characters.filter((character) => !/\s/u.test(character));
  const hangul = characters.filter((character) => /[가-힣]/u.test(character));
  const words = text.match(/[가-힣]+/gu) ?? [];
  const administrativeTermHitCount = ADMINISTRATIVE_TERMS.filter((term) =>
    text.includes(term)
  ).length;
  let validBigrams = 0;
  let totalBigrams = 0;
  for (const word of words) {
    const values = [...word];
    for (let index = 0; index < values.length - 1; index += 1) {
      totalBigrams += 1;
      if (VALID_HANGUL_BIGRAMS.has(`${values[index]}${values[index + 1]}`)) {
        validBigrams += 1;
      }
    }
  }
  const particleCount = (
    text.match(
      /[가-힣]+(?:은|는|이|가|을|를|에|의|와|과|로|으로|에서|에게|도|만|부터|까지)(?=\s|[.,:;!?)]|$)/gu
    ) ?? []
  ).length;
  const administrativeTermHitRate =
    administrativeTermHitCount / ADMINISTRATIVE_TERMS.length;
  const validHangulBigramRatio =
    totalBigrams === 0 ? 0 : validBigrams / totalBigrams;
  const rareHangulSyllableRatio =
    hangul.length === 0
      ? 0
      : hangul.filter(rareHangulSyllable).length / hangul.length;
  const particleTokenRatio =
    words.length === 0 ? 0 : particleCount / words.length;
  const whitespaceBoundaryRatio =
    characters.length === 0
      ? 0
      : characters.filter((character) => /\s/u.test(character)).length /
        characters.length;
  const digitPunctuationRatio =
    characters.length === 0
      ? 0
      : characters.filter((character) =>
          /[0-9.,:;!?%()\-]/u.test(character)
        ).length / characters.length;
  const lexicalDeficit =
    1 - bounded(administrativeTermHitRate / 0.08);
  const bigramDeficit = 1 - bounded(validHangulBigramRatio / 0.08);
  const particleDeficit = 1 - bounded(particleTokenRatio / 0.03);
  const rareSyllableExcess = bounded(
    (rareHangulSyllableRatio - 0.45) / 0.2
  );
  const whitespaceDeficit =
    whitespaceBoundaryRatio < 0.12 ? 1 : 0;
  const digitPunctuationDeficit = digitPunctuationRatio < 0.05 ? 1 : 0;
  const mojibakeScore = bounded(
    lexicalDeficit * 0.25 +
      bigramDeficit * 0.25 +
      particleDeficit * 0.2 +
      rareSyllableExcess * 0.2 +
      whitespaceDeficit * 0.05 +
      digitPunctuationDeficit * 0.05
  );
  const signals: string[] = [];
  if (administrativeTermHitRate < 0.05) signals.push("low_administrative_hits");
  if (validHangulBigramRatio < 0.02) signals.push("low_valid_hangul_bigrams");
  if (particleTokenRatio < 0.01) signals.push("low_particle_ratio");
  if (rareHangulSyllableRatio > 0.55) signals.push("rare_hangul_composition");
  if (whitespaceBoundaryRatio < 0.12) signals.push("low_spacing_plausibility");
  if (digitPunctuationRatio < 0.05) {
    signals.push("low_digit_punctuation_plausibility");
  }
  return {
    nonWhitespaceCharacterCount: nonWhitespace.length,
    hangulCharacterCount: hangul.length,
    hangulRatio:
      nonWhitespace.length === 0 ? 0 : hangul.length / nonWhitespace.length,
    administrativeTermHitCount,
    administrativeTermHitRate,
    validHangulBigramRatio,
    rareHangulSyllableRatio,
    particleTokenRatio,
    whitespaceBoundaryRatio,
    digitPunctuationRatio,
    mojibakeScore,
    signals
  };
}

export function classifyDocumentKoreanText(
  text: string,
  hasVisualContent: boolean
): {
  classification: PdfContentClassification;
  evidence: KoreanTextPlausibility;
} {
  const evidence = scoreKoreanTextPlausibility(text);
  if (evidence.nonWhitespaceCharacterCount === 0) {
    return {
      classification: hasVisualContent ? "unusable_for_retrieval" : "empty",
      evidence
    };
  }
  const effectivelyNoKorean =
    evidence.hangulCharacterCount <
      Math.max(50, evidence.nonWhitespaceCharacterCount * 0.02) &&
    evidence.administrativeTermHitCount === 0;
  if (effectivelyNoKorean) {
    return { classification: "unusable_for_retrieval", evidence };
  }
  if (
    evidence.hangulCharacterCount >= 100 &&
    evidence.mojibakeScore >= 0.72 &&
    evidence.administrativeTermHitRate < 0.05 &&
    evidence.validHangulBigramRatio < 0.02 &&
    evidence.particleTokenRatio < 0.01
  ) {
    return { classification: "mojibake_suspected", evidence };
  }
  return { classification: "extracted_ok", evidence };
}

export function classifyPageKoreanText(
  text: string,
  hasVisualContent: boolean,
  documentClassification: PdfContentClassification
): {
  classification: PdfContentClassification;
  evidence: KoreanTextPlausibility;
} {
  const evidence = scoreKoreanTextPlausibility(text);
  if (evidence.nonWhitespaceCharacterCount === 0) {
    return {
      classification: hasVisualContent ? "unusable_for_retrieval" : "empty",
      evidence
    };
  }
  if (documentClassification === "mojibake_suspected") {
    return { classification: "mojibake_suspected", evidence };
  }
  if (documentClassification === "unusable_for_retrieval") {
    return { classification: "unusable_for_retrieval", evidence };
  }
  if (
    evidence.hangulCharacterCount >= 30 &&
    evidence.mojibakeScore >= 0.82 &&
    evidence.validHangulBigramRatio < 0.01 &&
    evidence.particleTokenRatio < 0.005
  ) {
    return { classification: "mojibake_suspected", evidence };
  }
  return { classification: "extracted_ok", evidence };
}
