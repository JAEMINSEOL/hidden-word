// 비교할 모델과 단가 (USD / 100만 토큰).
// Opus 5.5의 입력/출력/캐시 읽기와 Haiku 5.5의 입력/출력은 공식 단가표 기준이다.
// 나머지(캐시 쓰기 = 입력의 1.25배, Haiku·구형 모델 캐시 읽기 = 입력의 0.1배)는 일반 비율로 잡은 추정값이다.
// 실제 청구액은 Anthropic 콘솔에서 확인하고, 단가가 바뀌면 이 표만 고치면 된다.

export type ModelKey = "opus" | "haiku";

export interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const MODELS: Record<ModelKey, { id: string; label: string }> = {
  opus: { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  haiku: { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
};

// 응답의 model 필드(대체 모델로 처리된 경우 포함)로 단가를 찾는다.
export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** 사용량으로 비용(USD)을 계산한다. 단가를 모르는 모델이면 null. */
export function costUsd(modelId: string, usage: UsageLike): number | null {
  const p = PRICES[modelId];
  if (!p) return null;
  const m = 1_000_000;
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead) /
    m
  );
}
