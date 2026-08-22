import { z } from "zod";

/**
 * 사용자가 첫 화면에서 알려준 상황.
 *
 * 저장하지 않는다. 브라우저 세션 안에서만 유지되고, 서버로는 질문 문자열을
 * 만들기 위해 그때그때 전달된다. 화면 문구도 그렇게 약속하고 있다.
 */
export const personaSchema = z.object({
  region: z.string().trim().max(40).default(""),
  age: z.string().trim().max(20).default(""),
  interest: z.string().trim().max(60).default("")
});

export type Persona = z.infer<typeof personaSchema>;

export const emptyPersona: Persona = { region: "", age: "", interest: "" };

export function personaLabel(persona: Persona): string {
  return [persona.age && `${persona.age}세`, persona.region, persona.interest]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 페르소나를 질문에 붙인다.
 *
 * 에이전트 API는 질문 문자열 하나만 받고 500자를 넘기면 거절하므로, 맥락은
 * 짧은 접두어로 얹고 전체 길이를 잘라 맞춘다.
 */
export function composeQuestion(persona: Persona, message: string): string {
  const context = personaLabel(persona);
  const question = context ? `[${context}] ${message}` : message;
  return question.slice(0, 500);
}
