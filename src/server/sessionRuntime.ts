/* P2-3b(D2):SessionRuntime 装配——本批零生产流量,导出工厂供 P2-5;冒烟走合成 transport。
   全仓唯一 import createSessionRuntime 处(T5 rg 验收)。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RuntimeFault, createSessionRuntime } from "pi-agent-runtime";
import type {
  ModelConfig,
  ModelTransport,
  SessionRuntime,
  SessionRuntimeOptions,
} from "pi-agent-runtime";
import { buildLimits, makeAuditSink, resolveAuditPath, type AuthorizeHook } from "../adapters/piRuntime.js";
import { getBudgetStore } from "./fileBudgetStore.js";
import { acquireLock } from "./lockfile.js";

export interface ProjectSessionRuntimeOptions {
  /** 项目目录:storage.directory=<projectDir>/session 随项目目录自洽(--project 任意路径)。 */
  projectDir: string;
  /** 模型候选链(冒烟注入合成 transport;生产解析随 P2-5 接入)。 */
  candidates?: Array<{ model: ModelConfig; transport: ModelTransport }>;
  /** 审计路径(缺省经 resolveAuditPath 派生:auditPath > dataDir > defaultDataDir;账本目录=dirname(auditPath),R1-5)。 */
  auditPath?: string;
  /** J1:显式数据目录(auditPath 未给时定位审计与账本;与 piRuntime 同一派生规则,零分叉)。 */
  dataDir?: string;
  /** J1:宿主 SDK 级授权钩子(缺省=无条件放行;storage 级授权另属 storage.authorize,不动)。 */
  authorize?: AuthorizeHook;
}

/** bindings.json 条目(SDK 零读零校验,形状纯自定;R1-7 唯一核账源)。 */
export interface BindingRecord {
  operationId: string;
  taskId: string;
  purpose?: string;
  sessionId: string;
  branch: string;
  at: string;
}

const readBindings = (path: string): BindingRecord[] => {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BindingRecord[];
  } catch (error) {
    throw new Error(`会话绑定记录不可读(${path}):${error instanceof Error ? error.message : String(error)}`);
  }
};

const writeBindings = (path: string, list: BindingRecord[]): void => {
  mkdirSync(dirname(path), { recursive: true }); // 会话目录惰性创建(首个操作时)
  writeFileSync(path, JSON.stringify(list));
};

/**
 * R1-6/R1-7:装配选项 builder(单独导出供测试直接驱动 bindOperation/reconcile 语义)。
 * - budgets=D1 路径单例(跨进程 O_EXCL 收口);
 * - storage.acquireWriter=自研 O_EXCL 会话锁(session/.writer-lock,判死接管,每次会话
 *   操作含只读 inspect 都持 writer——KA1:SDK 无锁实现助手,宿主必须提供);
 * - bindOperation:追加写 bindings.json,按 operationId 幂等;同 id 异 taskId/purpose/
 *   sessionId/branch → STATE_FAILED(reject);
 * - reconcile:唯一核账源=bindings.json——open[] 每条要求 operationId 匹配且
 *   taskId/sessionId/branch 一致;缺失→unknown,不一致→denied;首跑 open=[] 全 ready(设计钉)。
 */
export function createSessionRuntimeOptions(
  opts: ProjectSessionRuntimeOptions,
): Omit<SessionRuntimeOptions, "model" | "transport" | "fallbacks"> {
  // J1:auditPath 派生复用 piRuntime 单一规则(KA4:两文件零分叉)
  const auditPath = resolveAuditPath(opts);
  const sessionDir = join(opts.projectDir, "session");
  const bindingsPath = join(sessionDir, "bindings.json");
  return {
    // J1:宿主授权钩子透传(缺省=无条件放行常量;结果仅进程内返回,P2-5 接工具时按 kind 收紧)
    authorize: opts.authorize ?? (async () => true),
    audit: makeAuditSink(auditPath),
    budgets: getBudgetStore(dirname(auditPath)),
    storage: {
      directory: sessionDir,
      // cwd 仅喂 JSONL 会话仓;P2-5 接工具时换专属工作区
      cwd: process.cwd(),
      policyVersion: "p2-3b",
      authorize: async (action) => action.kind !== "delete", // delete 拒绝(其余放行)
      acquireWriter: async (signal) => {
        if (signal.aborted) throw new RuntimeFault("CANCELLED");
        const held = acquireLock(join(sessionDir, ".writer-lock"), { resource: "会话写入" });
        return { release: async () => held.release() };
      },
    },
    bindOperation: async (input, signal) => {
      if (signal.aborted) throw new RuntimeFault("CANCELLED");
      mkdirSync(sessionDir, { recursive: true });
      const list = readBindings(bindingsPath);
      const existing = list.find((b) => b.operationId === input.operationId);
      if (existing) {
        const same =
          existing.taskId === input.taskId &&
          existing.sessionId === input.sessionId &&
          existing.branch === input.branch &&
          (existing.purpose ?? undefined) === (input.purpose ?? undefined);
        if (!same) throw new RuntimeFault("STATE_FAILED"); // R1-7:同 operationId 冲突 reject
        return; // 幂等
      }
      list.push({
        operationId: input.operationId,
        taskId: input.taskId,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        sessionId: input.sessionId,
        branch: input.branch,
        at: new Date().toISOString(),
      });
      writeBindings(bindingsPath, list);
    },
    reconcile: async (input, signal) => {
      if (signal.aborted) throw new RuntimeFault("CANCELLED");
      if (input.open.length === 0) return "ready"; // 设计钉:首跑 open=[] 先于 operationId 生成,全 ready
      const list = readBindings(bindingsPath);
      for (const op of input.open) {
        const bound = list.find((b) => b.operationId === op.operationId);
        if (!bound) return "unknown";
        if (bound.taskId !== input.taskId || bound.sessionId !== input.sessionId || bound.branch !== op.branch) {
          return "denied";
        }
      }
      return "ready";
    },
  };
}

/** R1-6 工厂:装配 createSessionRuntime(候选链必填——生产解析随 P2-5 接入)。 */
export function createProjectSessionRuntime(opts: ProjectSessionRuntimeOptions): SessionRuntime {
  if (!opts.candidates || opts.candidates.length === 0) {
    throw new Error("会话候选链必填:createProjectSessionRuntime({candidates})(生产解析随 P2-5 接入)");
  }
  return createSessionRuntime({
    ...createSessionRuntimeOptions(opts),
    model: opts.candidates[0].model,
    transport: opts.candidates[0].transport,
    fallbacks: opts.candidates.slice(1).map((c) => ({ model: c.model, transport: c.transport })),
    // 会话任务卡 limits 与 plain 通道同语义(uncapped 单次保护)
    // 注:buildLimits 经调用方传入 run 请求,此处不固化
  });
}

/** 供冒烟/测试:与 plain 通道一致的 limits(session taskId 建议加 sess: 前缀隔离命名空间)。 */
export const sessionLimits = buildLimits;

/* ── P2-5 会话研究记忆(D1/R1-8)────────────────────────────────────────── */

import type { ResearchRun, ResearchResultBundle } from "../contracts.js";
import { resolveModelConfig, transportFor, type LiveModelConfig } from "../adapters/piRuntime.js";

/** 会话 taskId 收口(R2 前缀机制化:与 plain dr: 命名空间隔离)。 */
export const sessionTaskId = (purpose: string, key: string): string => `sess:${purpose}:${key}`;

/** R1-4:生产候选链解析(config.model 链→ModelConfig+transport;零可用→null 降级零纪要)。 */
export function resolveSessionCandidates(
  configs: LiveModelConfig | LiveModelConfig[] | undefined,
): Array<{ model: ModelConfig; transport: ModelTransport }> | null {
  if (!configs) return null;
  const chain = Array.isArray(configs) ? configs : [configs];
  const out: Array<{ model: ModelConfig; transport: ModelTransport }> = [];
  for (const cfg of chain) {
    try {
      const model = resolveModelConfig(cfg);
      const transport = transportFor(model);
      if (transport) out.push({ model, transport });
    } catch {
      /* 真值表外/自定义缺 key:跳过该候选 */
    }
  }
  return out.length > 0 ? out : null;
}

/** R1-8:run 终态摘要模板(硬顶 800B;cancelled/failed 也写,如实记状态)。 */
export function buildRunDigest(run: ResearchRun, bundle: ResearchResultBundle | null): string {
  const counts = { answered: 0, partially: 0, unanswered: 0, skipped: 0 };
  const qs = (run.progress?.total ?? 0);
  counts.answered = run.progress?.answered ?? 0;
  counts.skipped = run.progress?.skipped ?? 0;
  counts.unanswered = Math.max(0, qs - counts.answered - counts.skipped);
  const statusLabel: Record<string, string> = {
    published: "完整交付",
    limited: "有限交付",
    cancelled: "已取消",
    failed: "失败",
  };
  const claimTitles = (bundle?.claims ?? [])
    .slice(0, 5)
    .map((c) => c.statement.slice(0, 40))
    .join(";");
  // REVIEW F3:补目标(bundle.reportMd 首个 # 标题)与口径注记(interventions 中的 refine-direction)
  const goal = bundle?.reportMd?.match(/^#\s+(.+)$/m)?.[1] ?? "";
  const directionNotes = (run.interventions ?? [])
    .filter((i) => i.instruction?.type === "refine-direction")
    .map((i) => (i.instruction as { note?: string }).note ?? "")
    .filter(Boolean)
    .join(";");
  const lines = [
    `[${run.requestId}] ${statusLabel[run.status] ?? run.status} · 问题 ${counts.answered}答/${counts.unanswered}未/${counts.skipped}跳`,
    goal ? `目标: ${goal.slice(0, 60)}` : "",
    directionNotes ? `口径注记: ${directionNotes.slice(0, 120)}` : "",
    bundle ? `要点: ${claimTitles}` : run.error ? `中断: ${run.error.slice(0, 60)}` : "",
  ].filter(Boolean);
  const text = lines.join(" | ");
  return text.length > 800 ? `${text.slice(0, 797)}…` : text;
}

/**
 * D1:run 完成写会话摘要(update 零模型直写,R1)。
 * 会话惰性:缺失→create + **一次真实 session run()**(首条=基准摘要任务卡,全链验证 R4)。
 * 写失败不阻塞(调用方 catch;此处不吞——由 writeSessionDigestSafe 包装)。
 */
export async function writeSessionDigest(
  rt: SessionRuntime,
  run: ResearchRun,
  bundle: ResearchResultBundle | null,
): Promise<void> {
  const digest = buildRunDigest(run, bundle);
  let sessionId: string | undefined;
  const existing = await rt.list();
  sessionId = existing[0]?.id;
  if (!sessionId) {
    const info = await rt.create();
    sessionId = info.id;
    // R4:首次真实 run()——claim/bind/reconcile/drive 全链验证(一次性成本)
    await rt.run({
      sessionId,
      taskId: sessionTaskId("first", run.id),
      prompt: `研究记忆初始化。本研究项目的首条纪要如下:\n${digest}`,
      limits: buildLimits(),
      tools: [],
    });
    return;
  }
  await rt.update(sessionId, {
    kind: "message",
    branch: "main",
    message: { role: "user", text: digest },
  });
}

/** readSessionDigests:tail K 条摘要(只在 followup 发起时读一次,勿进轮询)。 */
export async function readSessionDigests(
  rt: SessionRuntime,
  k = 3,
): Promise<string[]> {
  const sessions = await rt.list();
  const sessionId = sessions[0]?.id;
  if (!sessionId) return [];
  const entries = await rt.history(sessionId);
  return entries
    .filter((e) => e.kind === "message" && e.message?.role === "user" && e.message?.text)
    .slice(-k)
    .map((e) => (e.message?.text ?? "").slice(0, 800));
}
