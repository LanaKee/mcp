/**
 * 아직 끝나지 않은 JSON에서 완성된 조각만 꺼낸다.
 *
 * 모델이 블록을 하나씩 써 내려가는 동안 화면도 하나씩 채우려면, 응답 전체가
 * 닫히기를 기다릴 수 없다. `JSON.parse`는 미완성 문자열에 대해 아무것도 주지
 * 않으므로 최상위 배열 안에서 **괄호가 닫힌 객체만** 직접 찾아낸다.
 *
 * 문자열 안의 중괄호와 이스케이프를 세지 않으면 `"text": "{"` 하나에 스캐너가
 * 어긋나므로, 따옴표 상태를 들고 다닌다.
 */

/** `"blocks": [` 다음부터 완성된 객체의 JSON 텍스트를 순서대로 돌려준다. */
export function completedBlocks(text: string): string[] {
  const marker = text.search(/"blocks"\s*:\s*\[/u);
  if (marker < 0) return [];
  const start = text.indexOf("[", marker);
  if (start < 0) return [];

  const found: string[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        found.push(text.slice(objectStart, index + 1));
        objectStart = -1;
      }
      continue;
    }
    // 배열이 닫히면 블록 목록은 끝이다.
    if (char === "]" && depth === 0) break;
  }
  return found;
}

/** 완성된 `"summary"` 값만 꺼낸다. 아직 닫히지 않았으면 null. */
export function completedSummary(text: string): string | null {
  const match = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/u);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}
