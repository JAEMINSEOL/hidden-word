import Anthropic from "@anthropic-ai/sdk";
import type { ModelKey } from "./models";
import { MODELS } from "./models";
import { SimilarityError, cacheKey, scoreWithClaude, type SimilarityResult } from "./similarity";
import { checkWord } from "./validate";

export interface Env {
  /** Anthropic API 키. `wrangler secret put ANTHROPIC_API_KEY`로 등록한다. */
  ANTHROPIC_API_KEY: string;
  /** M1 실험실 접근 토큰. 없으면 모든 요청을 거절한다. `wrangler secret put LAB_TOKEN` */
  LAB_TOKEN?: string;
  /** 허용할 프론트 주소(쉼표로 구분). 사이트와 API가 같은 주소면 필요 없다. 예: "http://localhost:8000" */
  ALLOWED_ORIGINS?: string;
  /** (선택) 단어 쌍 점수 캐시. 없으면 캐시 없이 동작한다. */
  SIM_CACHE?: KVNamespace;
}

type CachedEntry = Pick<SimilarityResult, "valid" | "score" | "reason" | "servedBy">;

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : "";
  return {
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Lab-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

/** 타이밍 공격을 피하는 문자열 비교 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleSimilarity(request: Request, env: Env, cors: Record<string, string>) {
  const token = request.headers.get("X-Lab-Token") ?? "";
  if (!env.LAB_TOKEN || !safeEqual(token, env.LAB_TOKEN)) {
    return json({ error: "접근 토큰이 올바르지 않습니다." }, 401, cors);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "요청 본문이 JSON이 아닙니다." }, 400, cors);
  }

  const target = checkWord(body.target);
  if (!target.ok) return json({ error: `정답: ${target.error}` }, 400, cors);
  const word = checkWord(body.word);
  if (!word.ok) return json({ error: `힌트: ${word.error}` }, 400, cors);

  const model = body.model as ModelKey;
  if (!(model in MODELS)) return json({ error: "model은 opus 또는 haiku여야 합니다." }, 400, cors);

  const allowProperNouns = body.allowProperNouns === true;
  const noCache = body.noCache === true;

  // 정답과 똑같은 단어는 모델을 부르지 않는다.
  if (word.word === target.word) {
    return json(
      { valid: true, score: 100, reason: "정답과 같은 단어", servedBy: "exact-match", cached: false, costUsd: 0, latencyMs: 0 },
      200,
      cors,
    );
  }

  const input = { target: target.word, word: word.word, model, allowProperNouns };
  const key = cacheKey(input);

  if (!noCache && env.SIM_CACHE) {
    const hit = await env.SIM_CACHE.get<CachedEntry>(key, "json");
    if (hit) return json({ ...hit, cached: true, costUsd: 0, latencyMs: 0 }, 200, cors);
  }

  if (!env.ANTHROPIC_API_KEY) return json({ error: "서버에 API 키가 설정되지 않았습니다." }, 500, cors);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  try {
    const result = await scoreWithClaude(client, input);
    if (env.SIM_CACHE) {
      const entry: CachedEntry = {
        valid: result.valid,
        score: result.score,
        reason: result.reason,
        servedBy: result.servedBy,
      };
      // 처음 받은 점수를 계속 쓴다. 이미 있는 값은 덮어쓰지 않는다(noCache 실험 결과 포함).
      const existing = await env.SIM_CACHE.get(key);
      if (existing === null) await env.SIM_CACHE.put(key, JSON.stringify(entry));
    }
    return json({ ...result, cached: false }, 200, cors);
  } catch (error) {
    if (error instanceof SimilarityError) return json({ error: error.message }, error.status, cors);
    if (error instanceof Anthropic.RateLimitError) {
      return json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." }, 429, cors);
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return json({ error: "서버의 API 키가 올바르지 않습니다." }, 500, cors);
    }
    if (error instanceof Anthropic.APIError) {
      return json({ error: `Claude API 오류 (${error.status ?? "연결"})` }, 502, cors);
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, models: MODELS }, 200, cors);
    }
    if (request.method === "POST" && url.pathname === "/similarity") {
      return handleSimilarity(request, env, cors);
    }
    return json({ error: "없는 경로입니다." }, 404, cors);
  },
} satisfies ExportedHandler<Env>;
