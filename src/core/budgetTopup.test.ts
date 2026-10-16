import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { ResearchRequestSchema, type Budget, type Intervention, type ResearchRequest } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import type { MemoryStore } from "../stores/memory.js";
import { runResearch } from "./runResearch.js";
import type { PlanOutput } from "./stages.js";

/**
 * P2-6 T1/T2:运行中加注(同对象变异→capped 复位+quota-starved 重开+下一问受益)
 * 与问内 refine 即时注入(filtered take+工具返回值 note)。
 */

const bodies: Record<string, string> = {
  "https://a/1": "中国咖啡市场规模约 1,200 亿元(2025 年)。",
};
const USAGE = { modelCalls: 1, outputTokens: 16 };
const SUFFICIENT = '{"sufficient":true,"note":"已取得口径"}';

interface LogRow { name: string; result: unknown }

const fakes = (
  scripts: Parameters<typeof scriptedRunAgent>[0],
  log: LogRow[] = [],
  prompts: string[] = [],
): Adapters => ({
  search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
  page: { fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: { parse: async (page) => ({ bodyText: bodies[page.url] ?? "", parseStatus: "ok" as const }) },
  model: {
    extractClaims: async ({ snapshot }) => ({
      claims: [{ statement: `${snapshot.url} 的主张`, kind: "fact" as const, quote: "市场规模" }],
      usage: { ...USAGE },
    }),
    runStage: async () => ({ output: { findings: [], gaps: [] }, usage: { ...USAGE } }),
    runAgent: scriptedRunAgent(scripts, { log, onPrompt: (p) => prompts.push(p) }),
  },
});

const planOf = (...questions: string[]): { plan: PlanOutput } => ({
  plan: { questions: questions.map((q, i) => ({ id: `q${i + 1}`, question: q, status: "open" as const })) },
});

const gatherQuestions = async (store: MemoryStore, runId: string) => {
  const cp = (await store.checkpoints(runId)).findLast((c) => c.stage === "gather");
  return (cp?.data as { questions?: Array<{ id: string; status: string; unansweredReason?: string }> }).questions ?? [];
};

describe("运行中加注(P2-6 T1)", () => {
  it("中途加注:配额饿死问题自动重开、capped 复位(有限交付→完整交付)、下一问受益", async () => {
    const store = createMemoryStore();
    const scripts = ["市场规模", "门店数量", "竞争格局"].map((q) => ({
      match: q,
      turns: [
        { tool: { name: "web_search", args: { query: q } } },
        { tool: { name: "fetch_page", args: { url: "https://a/1" } } },
        { text: SUFFICIENT },
      ],
    }));
    const adapters = fakes(scripts);
    // 问启动前的时序钩子:q1/q2 空批,q3 启动时模拟"加注 POST 到达"(同对象原地变异)
    let budgetRef: Budget | undefined;
    const actions: Array<() => void> = [() => {}, () => {}, () => { budgetRef!.maxSearches += 10; }];
    const request = ResearchRequestSchema.parse({
      id: "req-topup", module: "industry", goal: "加注", scope: { summary: "s", queries: [] },
      budget: { maxSearches: 1, maxFetches: 60, maxWallMs: 90 * 60_000, maxParallel: 4 },
    });
    const { run } = await runResearch(request, adapters, store, {
      runId: "run-topup",
      ...planOf("市场规模", "门店数量", "竞争格局"),
      stopAfter: "gather",
      registerBudget: (b) => { budgetRef = b; },
      pollInstructions: async () => {
        actions.shift()?.();
        return [];
      },
    });
    expect(budgetRef).toBeDefined();
    expect(budgetRef!.maxSearches).toBe(11); // 同对象被原地变异(registerBudget 拿到的是同一引用)
    // q2 曾被配额饿死(canSearch 闸门),q3 启动时加注到→评估点复位 capped+重开 q2
    expect(run.usage.searches).toBe(3); // q1+q3+重开的 q2
    expect(run.status).toBe("published"); // capped 复位:不再有限交付
    const questions = await gatherQuestions(store, "run-topup");
    expect(questions.every((q) => q.status === "answered")).toBe(true);
    expect(questions.every((q) => q.unansweredReason === undefined)).toBe(true);
  });

  it("insufficient 成因不因加注重开(只有 quota-starved 重开)", async () => {
    const store = createMemoryStore();
    const scripts = [
      { match: "市场规模", turns: [{ text: '{"sufficient":false,"note":"证据不足"}' }] },
      { match: "门店数量", turns: [{ tool: { name: "web_search", args: { query: "x" } } }, { tool: { name: "fetch_page", args: { url: "https://a/1" } } }, { text: SUFFICIENT }] },
    ];
    const adapters = fakes(scripts);
    let budgetRef: Budget | null = null;
    const actions: Array<() => void> = [() => { budgetRef!.maxSearches += 5; }];
    const { run } = await runResearch(
      ResearchRequestSchema.parse({ id: "req-topup-2", module: "industry", goal: "g", scope: { summary: "s", queries: [] } }),
      adapters, store,
      {
        runId: "run-topup-2",
        ...planOf("市场规模", "门店数量"),
        stopAfter: "gather",
        registerBudget: (b) => { budgetRef = b; },
        pollInstructions: async () => { actions.shift()?.(); return []; },
      },
    );
    expect(run.status).toBe("published");
    const questions = await gatherQuestions(store, "run-topup-2");
    expect(questions.find((q) => q.id === "q1")).toMatchObject({ status: "unanswered", unansweredReason: "insufficient" });
    expect(questions.find((q) => q.id === "q2")).toMatchObject({ status: "answered" });
  });
});

describe("问内 refine 即时注入(P2-6 T2)", () => {
  it("混装队列:executor 只消费 refine(skip/add 留队),note 进返回值与下一问任务卡,interventions 记录", async () => {
    const store = createMemoryStore();
    const log: LogRow[] = [];
    const prompts: string[] = [];
    const scripts = [
      {
        match: "市场规模",
        turns: [
          { tool: { name: "web_search", args: { query: "x" } } },
          { tool: { name: "fetch_page", args: { url: "https://a/1" } } },
          { text: SUFFICIENT },
        ],
      },
      { match: "门店数量", turns: [{ tool: { name: "web_search", args: { query: "y" } } }, { text: SUFFICIENT }] },
    ];
    const adapters = fakes(scripts, log, prompts);
    // 混装队列:refine 夹在 skip/add 之间(filtered take 只取 refine)
    const queue: Intervention[] = [
      { id: "ins-s", submittedAt: "2026-10-16T00:00:00.000Z", instruction: { type: "skip-question" } },
      { id: "ins-r", submittedAt: "2026-10-16T00:00:00.000Z", instruction: { type: "refine-direction", note: "重点看国内市场" } },
      { id: "ins-a", submittedAt: "2026-10-16T00:00:00.000Z", instruction: { type: "add-questions", questions: ["新问"] } },
    ];
    const { run } = await runResearch(
      ResearchRequestSchema.parse({ id: "req-refine", module: "industry", goal: "g", scope: { summary: "s", queries: [] } }),
      adapters, store,
      {
        runId: "run-refine",
        ...planOf("市场规模", "门店数量"),
        stopAfter: "gather",
        takeRefinement: () => {
          const idx = queue.findIndex((i) => i.instruction.type === "refine-direction");
          return idx >= 0 ? queue.splice(idx, 1)[0]! : null;
        },
      },
    );
    // ① 工具返回值 prepend note
    const searchResult = log.find((r) => r.name === "web_search")?.result as { note?: string };
    expect(searchResult?.note).toBe("方向调整:重点看国内市场");
    // ② skip/add 仍在队(refine 被取走)
    expect(queue.map((i) => i.instruction.type)).toEqual(["skip-question", "add-questions"]);
    // ③ interventions 记录(问内即时注入,applied)
    const applied = (run.interventions ?? []).find((i) => i.id === "ins-r");
    expect(applied).toMatchObject({ effect: "applied", detail: "问内即时注入" });
    expect(applied?.consumedAt).toBeTruthy();
    // ④ directionNotes 沉淀:下一问任务卡携带方向附注
    expect(prompts[1]).toContain("【方向附注】重点看国内市场");
  });
});

describe("加注评估窗补口(P2-6 F3)", () => {
  it("末问 runAgent 中加注:循环末评估窗复位 capped,不再有限交付", async () => {
    const store = createMemoryStore();
    const scripts = [
      {
        match: "【研究问题】市场规模",
        turns: [
          { tool: { name: "web_search", args: { query: "q1" } } },
          { tool: { name: "fetch_page", args: { url: "https://a/1" } } },
          { text: SUFFICIENT },
        ],
      },
      {
        match: "【研究问题】门店数量",
        turns: [
          { tool: { name: "web_search", args: { query: "q2a" } } },
          // 第二次搜索触顶(usage>=maxSearches)→工具置 capped=true 后返回配额错误
          { tool: { name: "web_search", args: { query: "q2b" } } },
          { tool: { name: "fetch_page", args: { url: "https://a/1" } } },
          { text: SUFFICIENT },
        ],
      },
    ];
    const adapters = fakes(scripts);
    let budgetRef: Budget | undefined;
    let fetchCalls = 0;
    adapters.page.fetch = async (url): Promise<FetchedPage> => {
      fetchCalls += 1;
      // 末问(最后一问)runAgent 进行中加注:q2 的抓取回合模拟 POST /runs/:id/budget 到达
      if (fetchCalls === 2) budgetRef!.maxSearches += 10;
      return { url, status: 200, contentType: "text/html", html: "<p>x</p>" };
    };
    const { run } = await runResearch(
      ResearchRequestSchema.parse({
        id: "req-last-q",
        module: "industry",
        goal: "g",
        scope: { summary: "s", queries: [] },
        budget: { maxSearches: 2, maxFetches: 60, maxWallMs: 90 * 60_000, maxParallel: 4 },
      }),
      adapters,
      store,
      {
        runId: "run-last-q",
        ...planOf("市场规模", "门店数量"),
        stopAfter: "gather",
        registerBudget: (b) => {
          budgetRef = b;
        },
      },
    );
    expect(fetchCalls).toBe(2);
    // 修复前:末问后无问开始评估点,capped 停在 true → run 有限交付
    expect(run.status).toBe("published");
    const questions = await gatherQuestions(store, "run-last-q");
    expect(questions.every((q) => q.status === "answered")).toBe(true);
  });

  it("采证后加注:quota-starved 问题在发布门评估前重开补采", async () => {
    const base = createMemoryStore();
    let budgetRef: Budget | undefined;
    let topped = false;
    const store: MemoryStore = {
      ...base,
      saveCheckpoint: async (checkpoint) => {
        // 采证收束落盘(gather 检查点)瞬间模拟加注到达——gather 已返回,评估扫描尚未执行
        if (checkpoint.stage === "gather" && !topped) {
          topped = true;
          budgetRef!.maxSearches += 10;
        }
        return base.saveCheckpoint(checkpoint);
      },
    };
    const scripts = ["市场规模", "门店数量"].map((q) => ({
      match: `【研究问题】${q}`,
      turns: [
        { tool: { name: "web_search", args: { query: q } } },
        { tool: { name: "fetch_page", args: { url: "https://a/1" } } },
        { text: SUFFICIENT },
      ],
    }));
    const adapters = fakes(scripts);
    const { run } = await runResearch(
      ResearchRequestSchema.parse({
        id: "req-post-gather",
        module: "industry",
        goal: "g",
        scope: { summary: "s", queries: [] },
        budget: { maxSearches: 1, maxFetches: 60, maxWallMs: 90 * 60_000, maxParallel: 4 },
      }),
      adapters,
      store,
      {
        runId: "run-post-gather",
        ...planOf("市场规模", "门店数量"),
        stopAfter: "gather",
        registerBudget: (b) => {
          budgetRef = b;
        },
      },
    );
    expect(topped).toBe(true);
    expect(run.usage.searches).toBe(2); // q1 + 重开补采的 q2
    expect(run.status).toBe("published");
    const questions = await gatherQuestions(store, "run-post-gather");
    expect(questions.every((q) => q.status === "answered")).toBe(true);
    expect(questions.every((q) => q.unansweredReason === undefined)).toBe(true);
  });

  it("采证后加注(analyze 窗口):capped 复位恢复 polish/review 回环", async () => {
    const store = createMemoryStore();
    const stages: string[] = [];
    let budgetRef: Budget | undefined;
    const scripts = [
      {
        match: "【研究问题】市场规模",
        turns: [
          { tool: { name: "web_search", args: { query: "q1" } } },
          { tool: { name: "fetch_page", args: { url: "https://a/1" } } },
          { text: SUFFICIENT },
        ],
      },
      { match: "【研究问题】门店数量", turns: [{ tool: { name: "web_search", args: { query: "q2" } } }, { text: SUFFICIENT }] },
    ];
    const adapters = fakes(scripts);
    adapters.model.runStage = async (stage) => {
      stages.push(stage);
      // analyze 模型调用进行中模拟加注到达(采证已收束,q2 曾 quota-starved)
      if (stage === "analyze") budgetRef!.maxSearches += 10;
      if (stage === "draft") return { output: { reportMd: "# 草稿" }, usage: { ...USAGE } };
      if (stage === "review") return { output: { issues: [], counterexampleChecked: true }, usage: { ...USAGE } };
      return { output: { findings: [], gaps: [] }, usage: { ...USAGE } };
    };
    const { run } = await runResearch(
      ResearchRequestSchema.parse({
        id: "req-gate-restore",
        module: "industry",
        goal: "g",
        scope: { summary: "s", queries: [] },
        budget: { maxSearches: 1, maxFetches: 60, maxWallMs: 90 * 60_000, maxParallel: 4 },
      }),
      adapters,
      store,
      {
        runId: "run-gate-restore",
        ...planOf("市场规模", "门店数量"),
        registerBudget: (b) => {
          budgetRef = b;
        },
      },
    );
    // 修复前:capped 压住 polish/review 两门(评估点只在问开始处)
    expect(stages).toContain("polish");
    expect(stages).toContain("review");
    expect(run.usage.searches).toBe(1); // q2 未重开(问题重开只在 gather 窗口),复位只恢复回环
  });

  it("gap targets ∩ starved:每问只调查一次(REVIEW B1——重开递归不重复本轮目标)", async () => {
    const store = createMemoryStore();
    const prompts: string[] = [];
    const scripts = [
      {
        match: "【研究问题】市场规模",
        turns: [
          { tool: { name: "web_search", args: { query: "q1" } } },
          { tool: { name: "fetch_page", args: { url: "https://a/1" } } },
          { text: SUFFICIENT },
        ],
      },
      {
        match: "【研究问题】门店数量",
        turns: [
          { tool: { name: "web_search", args: { query: "q2" } } },
          { tool: { name: "fetch_page", args: { url: "https://a/1" } } },
          { text: SUFFICIENT },
        ],
      },
    ];
    const adapters = fakes(scripts, [], prompts);
    let budgetRef: Budget | undefined;
    adapters.model.runStage = async (stage) => {
      if (stage === "analyze") {
        // analyze 窗口加注 + 缺口直指 starved 的 q2(gap targets ∩ starved 的实证触发面)
        budgetRef!.maxSearches += 10;
        return { output: { findings: [], gaps: [{ questionId: "q2", reason: "缺门店数口径" }] }, usage: { ...USAGE } };
      }
      if (stage === "draft") return { output: { reportMd: "# 草稿" }, usage: { ...USAGE } };
      if (stage === "review") return { output: { issues: [], counterexampleChecked: true }, usage: { ...USAGE } };
      return { output: { findings: [], gaps: [] }, usage: { ...USAGE } };
    };
    const { run } = await runResearch(
      ResearchRequestSchema.parse({
        id: "req-b1",
        module: "industry",
        goal: "g",
        scope: { summary: "s", queries: [] },
        budget: { maxSearches: 1, maxFetches: 60, maxWallMs: 90 * 60_000, maxParallel: 4 },
      }),
      adapters,
      store,
      {
        runId: "run-b1",
        ...planOf("市场规模", "门店数量"),
        registerBudget: (b) => {
          budgetRef = b;
        },
      },
    );
    // 缺口补采恰好一轮:B1 缺陷下重开递归会把 gap 目标再采一轮(双轮调查+清除第一轮主张)
    const q2Investigations = prompts.filter((p) => p.includes("【研究问题】门店数量")).length;
    expect(q2Investigations).toBe(1);
    expect(run.usage.searches).toBe(2); // q1 首轮 1 次 + q2 补采 1 次(无第二轮)
  });

  it("双加注+中途配额耗尽:同一问跨扫描重复入列也不双轮调查(REVIEW B1R)", async () => {
    const store = createMemoryStore();
    const prompts: string[] = [];
    const scripts = [
      { match: "【研究问题】q1", turns: [{ tool: { name: "web_search", args: { query: "a" } } }, { tool: { name: "fetch_page", args: { url: "https://a/1" } } }, { text: SUFFICIENT }] },
      { match: "【研究问题】q2", turns: [{ tool: { name: "web_search", args: { query: "b" } } }, { tool: { name: "fetch_page", args: { url: "https://a/1" } } }, { text: SUFFICIENT }] },
      { match: "【研究问题】q3", turns: [{ tool: { name: "web_search", args: { query: "c" } } }, { tool: { name: "fetch_page", args: { url: "https://a/1" } } }, { text: SUFFICIENT }] },
      { match: "【研究问题】q4", turns: [{ tool: { name: "web_search", args: { query: "d" } } }, { tool: { name: "fetch_page", args: { url: "https://a/1" } } }, { text: SUFFICIENT }] },
    ];
    const adapters = fakes(scripts, [], prompts);
    let budgetRef: Budget | undefined;
    adapters.model.runStage = async (stage) => {
      if (stage === "analyze") {
        // 一次加注(1→2)+缺口直指 q2/q3/q4(gap targets ∩ starved)
        budgetRef!.maxSearches += 1;
        return {
          output: { findings: [], gaps: [{ questionId: "q2", reason: "x" }, { questionId: "q3", reason: "x" }, { questionId: "q4", reason: "x" }] },
          usage: { ...USAGE },
        };
      }
      if (stage === "draft") return { output: { reportMd: "# 草稿" }, usage: { ...USAGE } };
      if (stage === "review") return { output: { issues: [], counterexampleChecked: true }, usage: { ...USAGE } };
      return { output: { findings: [], gaps: [] }, usage: { ...USAGE } };
    };
    let pollCount = 0;
    const { run } = await runResearch(
      ResearchRequestSchema.parse({
        id: "req-b1r",
        module: "industry",
        goal: "g",
        scope: { summary: "s", queries: [] },
        budget: { maxSearches: 1, maxFetches: 60, maxWallMs: 90 * 60_000, maxParallel: 4 },
      }),
      adapters,
      store,
      {
        runId: "run-b1r",
        ...planOf("q1", "q2", "q3", "q4"),
        registerBudget: (b) => {
          budgetRef = b;
        },
        pollInstructions: async () => {
          pollCount += 1;
          // 7 次问启动 drain 后=补采轮 q4 起问(q3 已被重标 starved):二次加注触达循环末二次扫描
          if (pollCount === 7) budgetRef!.maxSearches += 10;
          return [];
        },
      },
    );
    // q3 路径:补采轮被重标 starved → 二次扫描再入列(重复 [q3,q3])——递归去重后只采一轮
    const q3Investigations = prompts.filter((p) => p.includes("【研究问题】q3")).length;
    expect(q3Investigations).toBe(1);
    expect(run.usage.searches).toBe(4); // q1 首轮 + 补采 q2/q4 + 重开 q3 各 1 次
  });
});
