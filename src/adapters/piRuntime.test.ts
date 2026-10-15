/* P2-1 T5:piRuntime 合成 transport 离线测试——钉红队三条 kill-assumption 的修复与三分映射。
   不触网:全部经 PiRuntimeOptions.candidates 注入假 transport。 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelConfig, ModelReply, ModelRequest, ModelTransport } from "pi-agent-runtime";
import { piRuntimeModel, type LiveModelConfig } from "./piRuntime.js";

const M3: ModelConfig = {
  provider: "minimax-cn",
  id: "MiniMax-M3",
  protocol: "anthropic-messages",
  endpoint: "https://api.minimaxi.com/anthropic",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
  reasoning: true,
  input: ["text"],
};
const MIMO: ModelConfig = {
  provider: "xiaomi-token-plan-cn",
  id: "mimo-v2.6-flash",
  protocol: "openai-completions",
  endpoint: "https://token-plan-cn.xiaomimimo.com/v1",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  input: ["text"],
};

const reply = (text: string): ModelReply => ({
  content: [{ kind: "text", text }],
  stop: "complete",
  usage: { inputTokens: 1, outputTokens: 1 },
});
const staticTransport = (text: string): ModelTransport => async () => reply(text);

let auditPath: string;
beforeEach(() => {
  auditPath = join(mkdtempSync(join(tmpdir(), "dr-pirt-")), "model-audit.jsonl");
});
afterEach(() => {
  delete process.env.DR_MODEL_TIMEOUT_MS;
});

describe("piRuntime runText 三分映射", () => {
  it("(a) 围栏 JSON plan 与裸 Markdown draft 均正常解析(钉 KA1:runText 透传原始文本)", async () => {
    const provider = piRuntimeModel([], {
      auditPath,
      candidates: [
        {
          model: M3,
          transport: (async (req: ModelRequest) =>
            reply(
              (req.messages.at(-1)?.text ?? "").includes("研究计划器")
                ? '```json\n{"questions":[{"id":"q1","question":"市场规模","status":"open"}]}\n```'
                : "# 报告\n\n## 市场\n内容",
            )) as ModelTransport,
        },
      ],
    });
    const plan = await provider.runStage("plan", { goal: "g" }, "t:plan:0");
    expect((plan.output as { questions: unknown[] }).questions).toHaveLength(1);
    const draft = await provider.runStage("draft", { outline: null }, "t:draft:0");
    expect((draft.output as { reportMd: string }).reportMd).toContain("# 报告");
  });

  it("(b) 并发 8 调用同前缀 taskId → 零 TASK_BUSY(钉 KA2:子 taskId 账本)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const transport: ModelTransport = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return reply('{"findings":[],"gaps":[]}');
    };
    const provider = piRuntimeModel([], { auditPath, candidates: [{ model: M3, transport }] });
    const outs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => provider.runStage("analyze", { claims: [] }, `t:conc:${i}`).then((o) => ({ ok: o.output !== undefined }))),
    );
    expect(outs.every((o) => o.ok)).toBe(true);
    expect(maxInFlight).toBeGreaterThan(1); // 并发真实发生(未串行化)
  });

  it("(c) 主候选挂起超时 → modelTimeoutMs 到期切备用成功(钉 KA3:uncapped 单次超时 + modelRecovery)", async () => {
    process.env.DR_MODEL_TIMEOUT_MS = "200";
    const hangMain: ModelTransport = (_req) =>
      new Promise((_resolve, reject) => {
        _req.signal.addEventListener("abort", () => reject(new Error("aborted: model timeout")), { once: true });
      });
    const provider = piRuntimeModel([], {
      auditPath,
      candidates: [
        { model: M3, transport: hangMain },
        { model: MIMO, transport: staticTransport('{"reportMd":"备用链产物"}') },
      ],
    });
    const started = Date.now();
    const out = await provider.runStage("draft", {}, "t:timeout:0");
    expect(Date.now() - started).toBeLessThan(5_000); // 秒级切换,非整 run 失败
    expect((out.output as { reportMd: string }).reportMd).toBe("备用链产物");
  }, 10_000);

  it("(e) 截断(stop=length)→ INVALID_OUTPUT 降级桶:draft 得 {}、extract 得空 claims(与现状解析失败等价)", async () => {
    const truncated: ModelTransport = async () => ({
      content: [{ kind: "text", text: "被截断的残文" }],
      stop: "length",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const provider = piRuntimeModel([], { auditPath, candidates: [{ model: M3, transport: truncated }] });
    const draft = await provider.runStage("draft", {}, "t:trunc:0");
    expect(draft.output).toEqual({});
    const claims = await provider.extractClaims(
      { snapshot: { url: "https://a", title: "A", bodyText: "正文", fetchedAt: "", parseStatus: "ok" } as never },
      "t:trunc:1",
    );
    expect(claims.claims).toEqual([]);
    expect(claims.usage.modelCalls).toBeGreaterThanOrEqual(1); // 成功路径至少 1 次(备用含预留保守)
  });

  it("(f) 审计事件落盘:JSONL 可解析,taskId 前缀 dr:、版本 1.0", async () => {
    const provider = piRuntimeModel([], { auditPath, candidates: [{ model: M3, transport: staticTransport('{"issues":[],"counterexampleChecked":true}') }] });
    await provider.runStage("review", {}, "t:audit:0");
    const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.every((l) => l.version === "1.0")).toBe(true);
    expect(lines.some((l) => l.taskId === "dr:t:audit:0" && l.kind === "run.started")).toBe(true);
    expect(lines.some((l) => l.kind === "model.admitted")).toBe(true);
    expect(lines.some((l) => l.kind === "run.finished")).toBe(true);
  });
});

describe("(d) 无密钥候选跳过与真值表拒绝", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("全部候选无密钥 → 与现状同形的缺少密钥错误(零可用候选不静默;工厂惰性,首调触发)", async () => {
    const provider = piRuntimeModel([{ provider: "minimax-cn", modelId: "MiniMax-M3" }], { auditPath });
    await expect(provider.runStage("plan", {}, "t:nokey:0")).rejects.toThrow(/缺少模型密钥.*MINIMAX_CN_API_KEY/);
  });

  it("真值表外内建模型显式拒绝(R1-2c)", async () => {
    process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY = "test-key";
    const provider = piRuntimeModel([{ provider: "minimax-cn", modelId: "MiniMax-M2.7" }] as LiveModelConfig[], { auditPath });
    await expect(provider.runStage("plan", {}, "t:reject:0")).rejects.toThrow(/本批未接入内建模型/);
  });
});
