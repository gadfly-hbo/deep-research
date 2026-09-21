import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { httpSearch, livePage, liveParser, piAiModel, type HttpSearchConfig, type LiveModelConfig } from "./adapters/live.js";
import { mcpWebSearch } from "./adapters/mcpSearch.js";
import { searchWithFallback } from "./adapters/searchFailover.js";
import { xiaomiWebSearch } from "./adapters/xiaomiSearch.js";
import { recordingAdapters } from "./adapters/recording.js";
import { replayAdapters } from "./adapters/replay.js";
import type { Adapters, RecordedCall, Recording } from "./adapters/types.js";
import { createProject, publishBundle, runOnProject } from "./app/projectService.js";
import { ResearchRequestSchema } from "./contracts.js";
import { runResearch } from "./core/runResearch.js";
import { buildSpikeReport, type SpikeQuestionResult } from "./core/spikeReport.js";
import { FsProjectStore } from "./stores/fsStore.js";
import { createMemoryStore } from "./stores/memory.js";
import { startServer } from "./server/server.js";

type SearchConfig = HttpSearchConfig | { type: "minimax-mcp" } | { type: "xiaomi-websearch" };

function makeSearchOne(cfg: SearchConfig): Adapters["search"] {
  if ("type" in cfg && cfg.type === "minimax-mcp") {
    // 与 flow-center 同款:MiniMax MCP 的 web_search(minimax-coding-plan-mcp,stdio)
    return mcpWebSearch({
      command: "uvx",
      args: ["--with", "mcp<2", "minimax-coding-plan-mcp", "-y"],
      env: { MINIMAX_API_HOST: "https://api.minimaxi.com" },
      timeoutMs: 60_000,
    });
  }
  if ("type" in cfg && cfg.type === "xiaomi-websearch") {
    const apiKey = process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY;
    if (!apiKey) throw new Error("缺少 XIAOMI_TOKEN_PLAN_CN_API_KEY(xiaomi websearch)");
    return xiaomiWebSearch({ apiKey });
  }
  return httpSearch(cfg as HttpSearchConfig);
}

function makeSearch(cfg: SearchConfig | SearchConfig[]): Adapters["search"] {
  const chain = Array.isArray(cfg) ? cfg : [cfg];
  const providers = chain.map(makeSearchOne);
  return providers.length > 1 ? searchWithFallback(providers) : providers[0];
}

interface SpikeConfig {
  model?: LiveModelConfig | LiveModelConfig[];
  search?: SearchConfig | SearchConfig[];
}

interface Fixture {
  module?: "brand" | "industry";
  questions: string[];
  recording: Recording;
}

function loadConfig(): SpikeConfig {
  const dataDir = process.env.DEEP_RESEARCH_DATA_DIR ?? join(homedir(), ".deep-research");
  let fileConfig: SpikeConfig = {};
  try {
    fileConfig = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as SpikeConfig;
  } catch {
    // 无配置文件时仅用 env
  }
  const model =
    process.env.DEEP_RESEARCH_MODEL_PROVIDER && process.env.DEEP_RESEARCH_MODEL_ID
      ? { provider: process.env.DEEP_RESEARCH_MODEL_PROVIDER, modelId: process.env.DEEP_RESEARCH_MODEL_ID }
      : fileConfig.model;
  return { model, search: fileConfig.search };
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      flags[arg.slice(2)] = argv[i + 1] ?? "true";
      i++;
    }
  }
  return flags;
}

function loadQuestions(path: string): { module?: "brand" | "industry"; questions: string[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (Array.isArray(raw)) return { questions: raw as string[] };
  const rec = raw as { module?: "brand" | "industry"; questions?: string[] };
  if (!Array.isArray(rec.questions)) throw new Error(`问题文件格式错误: ${path}`);
  return { module: rec.module, questions: rec.questions };
}

async function spike(flags: Record<string, string>): Promise<void> {
  const questionsPath = flags.questions;
  if (!questionsPath) throw new Error("用法: npm run research -- spike --questions <path> [--replay <fixture>] [--record <out>] [--out <out>]");
  const { module, questions } = loadQuestions(questionsPath);

  let adapters: Adapters;
  const recorded: RecordedCall[] = [];
  if (flags.replay) {
    const fixture = JSON.parse(readFileSync(flags.replay, "utf8")) as Fixture;
    adapters = replayAdapters(fixture.recording);
  } else {
    const config = loadConfig();
    if (!config.model || !config.search) {
      throw new Error(
        "live spike 需要模型与搜索配置:在 <datadir>/config.json 提供 model {provider, modelId} 与 search {endpoint, urlField, titleField, snippetField, ...};密钥由 pi-ai 从环境读取(如 MINIMAX_API_KEY / KIMI_API_KEY / MOONSHOT_API_KEY)",
      );
    }
    adapters = {
      search: makeSearch(config.search),
      page: livePage(),
      parser: liveParser(),
      model: piAiModel(config.model),
    };
    if (flags.record) {
      adapters = recordingAdapters(adapters, (call) => recorded.push(call));
    }
  }

  const results: SpikeQuestionResult[] = [];
  try {
  for (let qi = 0; qi < questions.length; qi++) {
    const question = questions[qi];
    const request = ResearchRequestSchema.parse({
      id: `spike:${qi}`,
      module: module ?? "industry",
      goal: question,
      scope: { summary: "spike", queries: [question] },
      budget: { maxSearches: 1, maxFetches: 2 },
    });
    const { run, bundle } = await runResearch(request, adapters, createMemoryStore(), {
      plan: {
        questions: [{ id: "q0", question, status: "open" }],
      },
      stopAfter: "gather",
    });
    if (!bundle) throw new Error(`spike 未产出成果包: ${question}`);
    console.error(`[spike ${qi + 1}/${questions.length}] ${question.slice(0, 24)}… 判定=${bundle.verdicts.length} 命中=${bundle.verdicts.filter((v) => v.verdict === "quote-hit").length} 抓取=${bundle.snapshots.length} 用时=${(run.usage.wallMs / 1000).toFixed(0)}s`);
    results.push({
      question,
      verdicts: bundle.verdicts,
      fetched: bundle.snapshots.length,
      parsedOk: bundle.snapshots.filter((s) => s.parseStatus === "ok").length,
      costEstimate: run.usage.costEstimate,
      wallMs: run.usage.wallMs,
    });
  }

  const report = buildSpikeReport(results);
  const json = JSON.stringify(report, null, 2);
  if (flags.out) writeFileSync(flags.out, json);
  else console.log(json);
  if (flags.record) {
    writeFileSync(flags.record, JSON.stringify({ module, questions, recording: recorded }, null, 2));
  }
  console.error(
    `spike: 可验证率=${report.overallVerifiability.toFixed(2)} 可达率=${report.overallReachability.toFixed(2)} kill判据=${report.killCriteriaTriggered}`,
  );
  } finally {
    // 失败也要关闭 MCP 子进程,否则进程挂住
    await (adapters.search as { close?: () => Promise<void> }).close?.();
  }
}

function buildAdapters(flags: Record<string, string>, recorded: RecordedCall[]): Adapters {
  if (flags.replay) {
    const fixture = JSON.parse(readFileSync(flags.replay, "utf8")) as Fixture;
    return replayAdapters(fixture.recording);
  }
  const config = loadConfig();
  if (!config.model || !config.search) {
    throw new Error(
      "live 运行需要模型与搜索配置:在 <datadir>/config.json 提供 model {provider, modelId} 与 search {endpoint, urlField, titleField, snippetField, ...};密钥由 pi-ai 从环境读取",
    );
  }
  const live: Adapters = {
    search: makeSearch(config.search),
    page: livePage(),
    parser: liveParser(),
    model: piAiModel(config.model),
  };
  return flags.record ? recordingAdapters(live, (call) => recorded.push(call)) : live;
}

async function runCmd(flags: Record<string, string>): Promise<void> {
  if (!flags.request) throw new Error("用法: npm run research -- run --request <path> [--plan <path>] [--replay <fixture>] [--record <out>] [--out <out>]");
  const request = ResearchRequestSchema.parse(JSON.parse(readFileSync(flags.request, "utf8")) as unknown);
  const recorded: RecordedCall[] = [];
  const adapters = buildAdapters(flags, recorded);
  const plan = flags.plan
    ? (JSON.parse(readFileSync(flags.plan, "utf8")) as { questions: { id: string; question: string; status: "open" }[] })
    : undefined;
  const { run, bundle } = await runResearch(request, adapters, createMemoryStore(), { plan });
  const output = JSON.stringify({ run, bundle }, null, 2);
  if (flags.out) writeFileSync(flags.out, output);
  else console.log(output);
  if (flags.record) {
    writeFileSync(flags.record, JSON.stringify({ questions: [], recording: recorded }, null, 2));
  }
  await (adapters.search as { close?: () => Promise<void> }).close?.();
  console.error(`run: status=${run.status} 搜索=${run.usage.searches} 抓取=${run.usage.fetches} 成本≈${run.usage.costEstimate.toFixed(3)} 耗时=${run.usage.wallMs}ms`);
}

async function projectCmd(sub: string, flags: Record<string, string>): Promise<void> {
  const dataDir = flags.datadir ?? process.env.DEEP_RESEARCH_DATA_DIR ?? join(homedir(), ".deep-research");
  if (sub === "create") {
    if (!flags.request) throw new Error("用法: project create --request <path> [--datadir <path>]");
    const input = JSON.parse(readFileSync(flags.request, "utf8")) as {
      module: "brand" | "industry";
      goal: string;
      scope: { summary: string; queries: string[] };
    };
    const dir = createProject(dataDir, input);
    console.log(dir);
    return;
  }
  if (!flags.project) throw new Error(`用法: project ${sub} --project <dir> …`);
  if (sub === "run") {
    if (!flags.request) throw new Error("用法: project run --project <dir> --request <path> [--plan <path>] [--replay <fixture>] [--record <out>]");
    const request = ResearchRequestSchema.parse(JSON.parse(readFileSync(flags.request, "utf8")) as unknown);
    const recorded: RecordedCall[] = [];
    const adapters = buildAdapters(flags, recorded);
    const plan = flags.plan
      ? (JSON.parse(readFileSync(flags.plan, "utf8")) as { questions: { id: string; question: string; status: "open" }[] })
      : undefined;
    let result;
    try {
      result = await runOnProject(flags.project, request, adapters, { plan });
    } finally {
      await (adapters.search as { close?: () => Promise<void> }).close?.();
    }
    const { run, bundle } = result;
    console.log(JSON.stringify({ run, bundle }, null, 2));
    if (flags.record) writeFileSync(flags.record, JSON.stringify({ questions: [], recording: recorded }, null, 2));
    console.error(`run: status=${run.status} id=${run.id}`);
    return;
  }
  if (sub === "publish") {
    if (!flags.run) throw new Error("用法: project publish --project <dir> --run <runId>");
    const published = await publishBundle(flags.project, flags.run);
    console.log(JSON.stringify(published, null, 2));
    return;
  }
  if (sub === "open") {
    const store = FsProjectStore.open(flags.project);
    const meta = store.meta();
    const snapshots = await store.listSnapshots();
    console.log(JSON.stringify({ ...meta, snapshotCount: snapshots.length }, null, 2));
    return;
  }
  throw new Error(`未知 project 子命令: ${sub}(create / run / publish / open)`);
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

if (command === "serve") {
  const dataDir = flags.datadir ?? process.env.DEEP_RESEARCH_DATA_DIR ?? join(homedir(), ".deep-research");
  const config = loadConfig();
  const makeAdapters = (): Adapters => {
    if (!config.model || !config.search) {
      throw new Error("未配置模型/搜索(见 npm run research -- serve 的 config.json 说明);运行功能不可用,管理功能正常");
    }
    return { search: makeSearch(config.search), page: livePage(), parser: liveParser(), model: piAiModel(config.model) };
  };
  startServer({ dataDir, makeAdapters }, flags.port ? Number(flags.port) : 4173)
    .then((srv) => console.log(`工作台已启动(仅本机): http://127.0.0.1:${srv.port}`))
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
} else if (command === "project") {
  const [sub, ...subRest] = rest;
  if (!sub) {
    console.error("用法: npm run research -- project <create|run|publish|open> …");
    process.exitCode = 1;
  } else {
    projectCmd(sub, parseFlags(subRest)).catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
  }
} else if (command === "spike") {
  spike(flags).catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
} else if (command === "run") {
  runCmd(flags).catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
} else {
  console.error("用法: npm run research -- spike --questions <path> [--replay <fixture>] [--record <out>] [--out <out>]\n      npm run research -- run --request <path> [--plan <path>] [--replay <fixture>] [--record <out>] [--out <out>]");
  process.exitCode = 1;
}
