// 입력 단어 검증. Claude로 보내기 전에 걸러서 프롬프트 인젝션과 비용 악용을 막는다.

export const MAX_WORD_LENGTH = 15;
const HANGUL_WORD = /^[가-힣]+$/;

export type WordCheck = { ok: true; word: string } | { ok: false; error: string };

/** 앞뒤 공백 제거 + 유니코드 정규화(NFC). 자모가 분리된 입력도 완성형으로 합친다. */
export function normalizeWord(raw: string): string {
  return raw.normalize("NFC").trim();
}

export function checkWord(raw: unknown): WordCheck {
  if (typeof raw !== "string") return { ok: false, error: "단어가 문자열이 아닙니다." };
  const word = normalizeWord(raw);
  if (word.length === 0) return { ok: false, error: "단어를 입력하세요." };
  if (word.length > MAX_WORD_LENGTH) {
    return { ok: false, error: `단어는 ${MAX_WORD_LENGTH}자 이하여야 합니다.` };
  }
  if (!HANGUL_WORD.test(word)) {
    return { ok: false, error: "완성된 한글만 입력할 수 있습니다. 공백, 숫자, 영문, 기호는 쓸 수 없습니다." };
  }
  return { ok: true, word };
}

/** 모델이 돌려준 점수를 0~100 정수로 고정한다. */
export function clampScore(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
  return Math.min(100, Math.max(0, v));
}
