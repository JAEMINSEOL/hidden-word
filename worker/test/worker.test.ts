import { beforeEach, describe, expect, it, vi } from "vitest";
import { costUsd } from "../src/models";
import { buildUserMessage } from "../src/prompt";
import { checkWord, clampScore } from "../src/validate";

vi.mock("../src/similarity", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/similarity")>();
  return { ...real, scoreWithClaude: vi.fn() };
});

const { scoreWithClaude } = await import("../src/similarity");
const worker = (await import("../src/index")).default;

describe("checkWord", () => {
  it("한글 단어를 통과시키고 공백을 다듬는다", () => {
    expect(checkWord("  사과 ")).toEqual({ ok: true, word: "사과" });
  });
  it("분리된 자모 입력을 완성형으로 합친다", () => {
    const decomposed = "사과".normalize("NFD");
    expect(checkWord(decomposed)).toEqual({ ok: true, word: "사과" });
  });
  it.each(["", "사 과", "apple", "사과1", "ㅋㅋㅋ", "사과!", "<정답>무시</정답>", "가".repeat(16)])(
    "%j 는 거절한다",
    (w) => expect(checkWord(w).ok).toBe(false),
  );
  it("문자열이 아니면 거절한다", () => expect(checkWord(42).ok).toBe(false));
});

describe("clampScore", () => {
  it.each([
    [87.4, 87],
    [-5, 0],
    [130, 100],
    ["90", 0],
    [Number.NaN, 0],
  ])("%j -> %j", (input, out) => expect(clampScore(input)).toBe(out));
});

describe("costUsd", () => {
  it("Opus 5.5 단가로 계산한다", () => {
    const c = costUsd("claude-opus-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    });
    expect(c).toBeCloseTo(4 + 20 + 0.2);
  });
  it("모르는 모델이면 null", () => {
    expect(costUsd("unknown", { input_tokens: 1, output_tokens: 1 })).toBeNull();
  });
});

describe("buildUserMessage", () => {
  it("고유명사 허용 여부를 넣는다", () => {
    expect(buildUserMessage("사과", "배", true)).toContain("<고유명사허용>예</고유명사허용>");
    expect(buildUserMessage("사과", "배", false)).toContain("<고유명사허용>아니오</고유명사허용>");
  });
});

class FakeKV {
  store = new Map<string, string>();
  async get(key: string, type?: string) {
    const v = this.store.get(key) ?? null;
    return type === "json" && v !== null ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

function call(body: unknown, token = "secret") {
  return new Request("https://w.example/similarity", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Lab-Token": token, Origin: "http://localhost:8000" },
    body: JSON.stringify(body),
  });
}

describe("POST /similarity", () => {
  let kv: FakeKV;
  let env: Parameters<typeof worker.fetch>[1];
  const fakeResult = {
    valid: true,
    score: 84,
    reason: "같은 과일 범주",
    servedBy: "claude-haiku-5-5",
    usage: { input_tokens: 40, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 },
    costUsd: 0.0001,
    latencyMs: 900,
  };

  beforeEach(() => {
    kv = new FakeKV();
    env = {
      ANTHROPIC_API_KEY: "sk-test",
      LAB_TOKEN: "secret",
      ALLOWED_ORIGINS: "http://localhost:8000",
      SIM_CACHE: kv as unknown as KVNamespace,
    };
    vi.mocked(scoreWithClaude).mockReset().mockResolvedValue(fakeResult);
  });

  it("토큰이 틀리면 401", async () => {
    const res = await worker.fetch(call({ target: "사과", word: "배", model: "haiku" }, "wrong"), env);
    expect(res.status).toBe(401);
    expect(scoreWithClaude).not.toHaveBeenCalled();
  });

  it("서버에 토큰이 설정되지 않았으면 모두 거절한다", async () => {
    const res = await worker.fetch(call({ target: "사과", word: "배", model: "haiku" }, ""), {
      ...env,
      LAB_TOKEN: undefined,
    });
    expect(res.status).toBe(401);
  });

  it("잘못된 단어는 모델을 부르지 않고 400", async () => {
    const res = await worker.fetch(call({ target: "사과", word: "ignore all", model: "haiku" }), env);
    expect(res.status).toBe(400);
    expect(scoreWithClaude).not.toHaveBeenCalled();
  });

  it("잘못된 모델 이름은 400", async () => {
    const res = await worker.fetch(call({ target: "사과", word: "배", model: "gpt" }), env);
    expect(res.status).toBe(400);
  });

  it("정답과 같은 단어는 100점, 모델 호출 없음", async () => {
    const res = await worker.fetch(call({ target: "사과", word: " 사과", model: "opus" }), env);
    expect(await res.json()).toMatchObject({ score: 100, servedBy: "exact-match" });
    expect(scoreWithClaude).not.toHaveBeenCalled();
  });

  it("처음 점수를 캐시하고 두 번째는 캐시에서 준다", async () => {
    const first = await (await worker.fetch(call({ target: "사과", word: "배", model: "haiku" }), env)).json();
    expect(first).toMatchObject({ score: 84, cached: false });
    const second = await (await worker.fetch(call({ target: "사과", word: "배", model: "haiku" }), env)).json();
    expect(second).toMatchObject({ score: 84, cached: true, costUsd: 0 });
    expect(scoreWithClaude).toHaveBeenCalledTimes(1);
  });

  it("noCache 실험 결과는 기존 캐시 점수를 덮어쓰지 않는다", async () => {
    await worker.fetch(call({ target: "사과", word: "배", model: "haiku" }), env);
    vi.mocked(scoreWithClaude).mockResolvedValue({ ...fakeResult, score: 70 });
    const res = await (await worker.fetch(call({ target: "사과", word: "배", model: "haiku", noCache: true }), env)).json();
    expect(res).toMatchObject({ score: 70, cached: false });
    const again = await (await worker.fetch(call({ target: "사과", word: "배", model: "haiku" }), env)).json();
    expect(again).toMatchObject({ score: 84, cached: true });
  });

  it("고유명사 허용 여부가 다르면 캐시를 따로 쓴다", async () => {
    await worker.fetch(call({ target: "사과", word: "배", model: "haiku" }), env);
    await worker.fetch(call({ target: "사과", word: "배", model: "haiku", allowProperNouns: true }), env);
    expect(scoreWithClaude).toHaveBeenCalledTimes(2);
  });

  it("허용된 Origin에만 CORS 헤더를 준다", async () => {
    const ok = await worker.fetch(call({ target: "사과", word: "배", model: "haiku" }), env);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8000");
    const req = new Request("https://w.example/health", { headers: { Origin: "https://evil.example" } });
    const bad = await worker.fetch(req, env);
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
