/* J1:宿主装配级能力(红队 KA1/KA2/KA3/KA4 判据)——authorize 注入、显式 dataDir、channelCache 键派生化。
   缝(零新缝):PiRuntimeOptions.candidates 注入(piRuntime.test.ts 先例);T3 扩展 runResearch
   唯一执行入口(budgetTopup fakes 先例)。HTTP 消费形态由 src/server/server.test.ts 既有
   "创建→起跑→双门→发布→导出" loopback 全流程覆盖,本文件不重建。 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject, ModelConfig, ModelReply, ModelTransport } from "pi-agent-runtime";
import { piRuntimeModel, type AuthorizeHook } from "./piRuntime.js";
import { createProjectSessionRuntime, sessionLimits } from "../server/sessionRuntime.js";

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

const reply = (text: string): ModelReply => ({
  content: [{ kind: "text", text }],
  stop: "complete",
  usage: { inputTokens: 1, outputTokens: 1 },
});
const staticTransport = (text: string): ModelTransport => async () => reply(text);
const REVIEW_OK = '{"issues":[],"counterexampleChecked":true}';

let shieldDir: string | undefined;
beforeEach(() => {
  // 红期防污染:新选项未实现时 dataDir/auditPath 分支未生效,缺省会落 defaultDataDir()——
  // 先指到临时目录,避免把审计/账本写进仓库 research-data/(绿期行为不受影响)
  shieldDir = mkdtempSync(join(tmpdir(), "dr-j1-shield-"));
  process.env.DEEP_RESEARCH_DATA_DIR = shieldDir;
});
afterEach(() => {
  if (shieldDir) delete process.env.DEEP_RESEARCH_DATA_DIR;
});

describe("J1 T1:authorize 注入与两通道拒绝语义(KA2/KA3)", () => {
  it("恒拒 authorize:runStage rejects(文案含 AUTHORITY_REQUIRED);runAgent resolves blocked(同 reason)", async () => {
    const denyAll: AuthorizeHook = async () => false;
    const auditPath = join(mkdtempSync(join(tmpdir(), "dr-j1-a-")), "model-audit.jsonl");
    const provider = piRuntimeModel([], {
      auditPath,
      candidates: [{ model: M3, transport: staticTransport(REVIEW_OK) }],
      authorize: denyAll,
    });
    await expect(provider.runStage("review", {}, "j1:deny:text:0")).rejects.toThrow(/AUTHORITY_REQUIRED/);
    const res = await provider.runAgent!(
      { prompt: "【研究问题】J1 拒绝语义", taskId: "dr:j1:deny:gather-agent:r0:q1", toolExecution: "sequential" },
      [],
      "j1:deny:agent:0",
    );
    expect(res.status).toBe("blocked");
    expect(res.reason).toBe("AUTHORITY_REQUIRED");
  });

  it("缺省(不传 authorize)= 无条件放行:模型与发布检查全过,runStage 照常成功(KA3)", async () => {
    const auditPath = join(mkdtempSync(join(tmpdir(), "dr-j1-b-")), "model-audit.jsonl");
    const provider = piRuntimeModel([], {
      auditPath,
      candidates: [{ model: M3, transport: staticTransport(REVIEW_OK) }],
    });
    // 解析成功本身证明 model 准入与 publish 检查均被放行(任一被拒都会以 AUTHORITY_REQUIRED 抛错)
    const out = await provider.runStage("review", {}, "j1:allow:0");
    expect(out.output).toBeDefined();
    expect(out.usage.modelCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("J1 T1:channelCache 键派生化(KA1 判据)", () => {
  it("同候选链、不同 dataDir 与不同 authorize → 审计各自落位、策略各自生效,互不串道", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "dr-j1-ca-"));
    const dirB = mkdtempSync(join(tmpdir(), "dr-j1-cb-"));
    const transport = staticTransport(REVIEW_OK);
    const consumerA = piRuntimeModel([], {
      dataDir: dirA,
      candidates: [{ model: M3, transport }],
      authorize: async () => true,
    });
    const consumerB = piRuntimeModel([], {
      dataDir: dirB,
      candidates: [{ model: M3, transport }],
      authorize: async () => false,
    });
    const outA = await consumerA.runStage("review", {}, "j1:cache:a:0");
    expect(outA.output).toBeDefined();
    await expect(consumerB.runStage("review", {}, "j1:cache:b:0")).rejects.toThrow(/AUTHORITY_REQUIRED/);
    // 甲的审计目录不得出现乙的 taskId(串道判据),乙的审计落自己目录(落位判据)
    const auditA = readFileSync(join(dirA, "model-audit.jsonl"), "utf8");
    expect(auditA).not.toContain("j1:cache:b:0");
    expect(existsSync(join(dirB, "model-audit.jsonl"))).toBe(true);
  });
});

describe("J1 T1:auditPath 派生优先级(KA4)", () => {
  it("显式 auditPath 胜过 dataDir;账本目录=dirname(auditPath);仅 dataDir 时两者均落 dataDir", async () => {
    const dirX = mkdtempSync(join(tmpdir(), "dr-j1-px-"));
    const dirY = mkdtempSync(join(tmpdir(), "dr-j1-py-"));
    const auditY = join(dirY, "custom-audit.jsonl");
    const prio = piRuntimeModel([], {
      dataDir: dirX,
      auditPath: auditY,
      candidates: [{ model: M3, transport: staticTransport(REVIEW_OK) }],
    });
    await prio.runStage("review", {}, "j1:prio:0");
    expect(existsSync(auditY)).toBe(true);
    expect(existsSync(join(dirY, "model-budget.json"))).toBe(true);
    expect(existsSync(join(dirX, "model-audit.jsonl"))).toBe(false);

    const dirZ = mkdtempSync(join(tmpdir(), "dr-j1-pz-"));
    const onlyDataDir = piRuntimeModel([], {
      dataDir: dirZ,
      candidates: [{ model: M3, transport: staticTransport(REVIEW_OK) }],
    });
    await onlyDataDir.runStage("review", {}, "j1:prio:1");
    expect(existsSync(join(dirZ, "model-audit.jsonl"))).toBe(true);
    expect(existsSync(join(dirZ, "model-budget.json"))).toBe(true);
  });
});

describe("J1 T2:sessionRuntime 装配透传(authorize/dataDir)", () => {
  it("dataDir 定审计落位 + authorize 恒拒 → 会话 run blocked(照 dataSync.test.ts 会话冒烟形态)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "dr-j1-sproj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "dr-j1-sdata-"));
    const rt = createProjectSessionRuntime({
      projectDir,
      dataDir,
      candidates: [{ model: M3, transport: staticTransport("会话回复") }],
      authorize: async () => false,
    });
    const session = await rt.create();
    const run = await rt.run({ sessionId: session.id, taskId: "sess:j1:deny:1", prompt: "一问", limits: sessionLimits(), tools: [] });
    expect(run.status).toBe("blocked");
    expect(existsSync(join(dataDir, "model-audit.jsonl"))).toBe(true);
  });
});

/* ── J1 T3:宿主消费者进程内闭环 ────────────────────────────────────────────
   缝(全部既有):piRuntimeModel 候选注入(piRuntime.test.ts 先例)+ fakes(budgetTopup.test.ts
   先例)+ runResearch 唯一执行入口。HTTP 消费形态不在此重建——由 src/server/server.test.ts
   的"创建→起跑→双门→发布→导出"loopback 全流程覆盖(server 生产装配不传 J1 新选项,
   其等价性由既有测试守护)。 */
import type { FetchedPage } from "./types.js";
import { ResearchRequestSchema } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch } from "../core/runResearch.js";

const toolCallReply = (id: string, name: string, args: JsonObject): ModelReply => ({
  content: [{ kind: "tool", id, name, arguments: args }],
  stop: "tools",
  usage: { inputTokens: 1, outputTokens: 1 },
});

/** 全阶段路由 transport:抽取/分析/撰写/润色/评审按提示词标记应答;采证任务卡走两轮工具+终局。 */
const loopTransport: ModelTransport = async (req) => {
  const text = req.messages.map((m) => m.text ?? "").join("\n");
  if (text.includes("你是研究证据抽取器")) {
    return reply(JSON.stringify([{ statement: "中国咖啡市场规模约 1,200 亿元", kind: "fact", quote: "中国咖啡市场规模约 1,200 亿元" }]));
  }
  if (text.includes("你是证据分析器")) return reply('{"findings":[],"gaps":[]}');
  if (text.includes("你是研究报告撰写器") || text.includes("你是报告润色编辑")) {
    return reply(JSON.stringify({ reportMd: "# 咖啡市场报告\n\n## 执行摘要\n- 中国咖啡市场规模约 1,200 亿元。\n\n## 口径与局限披露\n- 合成闭环样例,证据单一。" }));
  }
  if (text.includes("你是研究评审器")) return reply('{"issues":[],"counterexampleChecked":true}');
  const toolTurns = req.messages.filter((m) => m.role === "tool").length;
  if (toolTurns === 0) return toolCallReply("t-search", "web_search", { query: "市场规模" });
  if (toolTurns === 1) return toolCallReply("t-fetch", "fetch_page", { url: "https://a/1" });
  return reply('{"sufficient":true,"note":"已取得口径"}');
};

const loopFakes = (model: ReturnType<typeof piRuntimeModel>) => ({
  search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
  page: { fetch: async (url: string): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: { parse: async () => ({ bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年)。", parseStatus: "ok" as const }) },
  model,
});

const loopRequest = () =>
  ResearchRequestSchema.parse({ id: "req-j1-loop", module: "industry", goal: "闭环验证", scope: { summary: "s", queries: [] } });
const loopPlan = { plan: { questions: [{ id: "q1", question: "市场规模", status: "open" as const }] } };

describe("J1 T3:宿主消费者进程内闭环", () => {
  it("装配(候选链+放行 authorize+dataDir)→ runResearch 完成 → 审计与账本落位 dataDir", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-j1-loop-"));
    const adapters = loopFakes(
      piRuntimeModel([], { dataDir, candidates: [{ model: M3, transport: loopTransport }], authorize: async () => true }),
    );
    const { run } = await runResearch(loopRequest(), adapters, createMemoryStore(), loopPlan);
    expect(["published", "limited"]).toContain(run.status); // 完整/有限交付皆可,不得 failed
    expect(run.usage.modelCalls).toBeGreaterThanOrEqual(3); // 采证 agent 轮 + 抽取 + 阶段调用
    expect(existsSync(join(dataDir, "model-audit.jsonl"))).toBe(true);
    expect(existsSync(join(dataDir, "model-budget.json"))).toBe(true);
  }, 30_000);

  it("进程内恒拒 provider → runResearch rejects 且文案含 AUTHORITY_REQUIRED(G1-5:无顶层 catch)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-j1-rej-"));
    const adapters = loopFakes(
      piRuntimeModel([], { dataDir, candidates: [{ model: M3, transport: loopTransport }], authorize: async () => false }),
    );
    await expect(runResearch(loopRequest(), adapters, createMemoryStore(), loopPlan)).rejects.toThrow(/AUTHORITY_REQUIRED/);
  }, 30_000);
});
