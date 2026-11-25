import Anthropic from "@anthropic-ai/sdk";
import { MODELS, costUsd, type ModelKey } from "./models";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, buildUserMessage } from "./prompt";
import { clampScore } from "./validate";

// 프롬프트를 고치면 이 값을 올린다. 캐시 키에 들어가서 예전 점수와 섞이지 않는다.
export const PROMPT_VERSION = "v1";

export interface SimilarityInput {
  target: string;
  word: string;
  model: ModelKey;
  allowProperNouns: boolean;
}

export interface SimilarityResult {
  valid: boolean;
  score: number;
  reason: string;
  /** 실제로 응답한 모델. 대체 모델이 처리했으면 요청한 모델과 다를 수 있다. */
  servedBy: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  costUsd: number | null;
  latencyMs: number;
}

export class SimilarityError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function scoreWithClaude(
  client: Anthropic,
  input: SimilarityInput,
): Promise<SimilarityResult> {
  const model = MODELS[input.model];
  const started = Date.now();

  const response = await client.beta.messages.create({
    model: model.id,
    // 사고 과정 토큰까지 포함한 상한. 출력 JSON 자체는 100토큰 안팎이다.
    max_tokens: 4000,
    // 단어 하나 채점이라 깊은 사고가 필요 없다. 두 모델 모두 사고를 끌 수 없어서 effort로 줄인다.
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    // 고정된 시스템 프롬프트에 캐시 지점을 둔다.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: buildUserMessage(input.target, input.word, input.allowProperNouns) },
    ],
    // Opus 5.5가 안전 분류기로 요청을 거절하면 서버가 대체 모델로 다시 처리한다.
    // Haiku 5.5는 서버 측 대체를 지원하지 않는다.
    ...(input.model === "opus"
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {}),
  });

  const latencyMs = Date.now() - started;

  if (response.stop_reason === "refusal") {
    throw new SimilarityError("모델이 이 단어의 채점을 거절했습니다.", 422);
  }
  if (response.stop_reason === "max_tokens") {
    throw new SimilarityError("모델 응답이 길이 제한에 걸렸습니다.", 502);
  }

  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

  let parsed: { valid?: unknown; score?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SimilarityError("모델 응답을 해석하지 못했습니다.", 502);
  }

  const valid = parsed.valid === true;
  const usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
  };

  return {
    valid,
    score: valid ? clampScore(parsed.score) : 0,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 80) : "",
    servedBy: response.model,
    usage,
    costUsd: costUsd(response.model, usage),
    latencyMs,
  };
}

export function cacheKey(input: SimilarityInput): string {
  return [PROMPT_VERSION, input.model, input.allowProperNouns ? "pn" : "np", input.target, input.word].join(
    ":",
  );
}
