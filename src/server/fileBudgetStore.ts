/* P2-3b(D1):持久预算账本 FileBudgetStore——路径级进程单例 + 单 async 互斥 + O_EXCL 跨进程
   收口(store 打开处)+ 租约接管(判死清 owner 保 usage)。lease 方法矩阵照抄内存版语义
   (budget.js),validateLimits/counted 照抄 policy.js(SDK 未导出)。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RuntimeFault } from "pi-agent-runtime";
import type { BudgetLease, BudgetStore, Limits, UncappedBudgetLease, UncappedLimits } from "pi-agent-runtime";
import { acquireLock, isLockOwnerDead, processBootId } from "./lockfile.js";

/* ---- policy.js 照抄(SDK 未导出) ---- */

const uncapped = (limits: Limits | UncappedLimits): limits is UncappedLimits => "cumulative" in limits;

function validateLimits(limits: Limits | UncappedLimits): void {
  const integer = (n: number, min = 0) => Number.isSafeInteger(n) && n >= min;
  const timeout = (n: number) => integer(n, 1) && n <= 2_147_483_647;
  if (uncapped(limits)) {
    if (
      limits.cumulative !== "unlimited" ||
      !integer(limits.maxOutputTokens, 1) ||
      !timeout(limits.modelTimeoutMs) ||
      !timeout(limits.toolTimeoutMs) ||
      !timeout(limits.controlTimeoutMs) ||
      Object.keys(limits).some(
        (k) => !["cumulative", "maxOutputTokens", "modelTimeoutMs", "toolTimeoutMs", "controlTimeoutMs"].includes(k),
      )
    ) {
      throw new RuntimeFault("INVALID_REQUEST");
    }
  } else if (
    !integer(limits.modelCalls, 1) ||
    !integer(limits.toolCalls) ||
    !integer(limits.outputTokens, 1) ||
    !timeout(limits.wallTimeMs) ||
    (limits.resourceUnits !== undefined && !integer(limits.resourceUnits))
  ) {
    throw new RuntimeFault("INVALID_REQUEST");
  }
}

/** 计量精度失败既不是预算触顶也不是清零(照抄 policy.counted)。 */
const counted = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RuntimeFault("STATE_FAILED");
  return n;
};

/* ---- 落盘形状 ---- */

interface TaskOwner {
  runId: string;
  pid: number;
  bootId: number;
  acquiredAt: string;
}

interface TaskEntry {
  configuration: string;
  limits: Limits | UncappedLimits;
  usage: Record<string, number>;
  owner?: TaskOwner;
}

interface BudgetFile {
  version: 1;
  tasks: Record<string, TaskEntry>;
}

const zeroUsage = (limits: Limits | UncappedLimits): Record<string, number> => ({
  modelCalls: 0,
  toolCalls: 0,
  outputTokens: 0,
  resourceUnits: 0,
  activeMs: 0,
  ...(uncapped(limits) ? { inputTokens: 0, reservedOutputTokens: 0 } : {}),
});

/**
 * R1-3 CONFIGURATION_CHANGED 两级文案:configuration 是 sha256 摘要拿不到原像——
 * limits(结构化入参)与落盘旧值逐字段点名;其余泛报指纹变化;出路文案恒定。
 */
const configurationChangedFault = (stored: TaskEntry, limits: Limits | UncappedLimits): RuntimeFault => {
  const sl = stored.limits as unknown as Record<string, unknown>;
  const nl = limits as unknown as Record<string, unknown>;
  const diff: string[] = [];
  for (const k of new Set([...Object.keys(sl), ...Object.keys(nl)])) {
    if (sl[k] !== nl[k]) diff.push(`${k}: 落盘 ${JSON.stringify(sl[k])} ≠ 现入 ${JSON.stringify(nl[k])}`);
  }
  const cause = diff.length
    ? `变化字段:${diff.join("、")}`
    : "limits 未变,任务配置指纹变化(候选链/工具/模型/会话策略任一)";
  const detail = `任务配置变化被拒——${cause}。出路:回滚配置后以原 taskId resume,或以新 taskId 另起新运行(旧账目保留)。`;
  return Object.assign(new RuntimeFault("CONFIGURATION_CHANGED"), { detail });
};

export class FileBudgetStore implements BudgetStore {
  /** 跨进程收口锁(进程生命周期持有,不释放)。 */
  private readonly lock;
  private readonly file: string;
  private readonly tmp: string;
  private tasks: Record<string, TaskEntry> | null = null; // 懒加载;加载后内存为权威
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly maxTasks: number,
  ) {
    this.lock = acquireLock(join(dataDir, ".model-budget-lock"), { resource: "预算账本" });
    this.file = join(dataDir, "model-budget.json");
    this.tmp = `${this.file}.tmp`;
  }

  /** 单 async 互斥:全部 lease 变更串行(路径级进程单例下无整文件覆盖竞态)。 */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(fn);
    this.chain = next;
    return next;
  }

  private ensureLoaded(): void {
    if (this.tasks !== null) return;
    if (!existsSync(this.file)) {
      this.tasks = { version: 1, tasks: {} }.tasks;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as BudgetFile;
      this.tasks = parsed.tasks ?? {};
    } catch (error) {
      throw new Error(
        `预算账本不可读(${this.file}):${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** tmp+rename 原子写;10 万 FIFO(剪最老已释放条目;owner 在役不剪)。 */
  private persist(): void {
    const entries = Object.keys(this.tasks!);
    if (entries.length > this.maxTasks) {
      let overflow = entries.length - this.maxTasks;
      for (const taskId of entries) {
        if (overflow <= 0) break;
        if (!this.tasks![taskId].owner) {
          delete this.tasks![taskId];
          overflow -= 1;
        }
      }
    }
    const body: BudgetFile = { version: 1, tasks: this.tasks! };
    writeFileSync(this.tmp, JSON.stringify(body));
    renameSync(this.tmp, this.file);
  }

  private lease(taskId: string, runId: string): BudgetLease {
    const entry = (): TaskEntry => {
      const t = this.tasks![taskId];
      if (!t) throw new RuntimeFault("STATE_FAILED");
      return t;
    };
    const assertOwner = (): void => {
      if (entry().owner?.runId !== runId) throw new RuntimeFault("TASK_BUSY");
    };
    const mutate = async <T>(fn: () => T): Promise<T> =>
      this.run(async () => {
        this.ensureLoaded();
        const result = fn();
        this.persist();
        return result;
      });
    const reserve = (maximum?: number): number => {
      assertOwner();
      const t = entry();
      const free = uncapped(t.limits);
      if (maximum === undefined) {
        if (free) throw new RuntimeFault("INVALID_REQUEST");
        maximum = (t.limits as Limits).outputTokens - t.usage.outputTokens;
      }
      if (!Number.isSafeInteger(maximum) || maximum < 1) {
        throw new RuntimeFault(free ? "INVALID_REQUEST" : "BUDGET_EXHAUSTED");
      }
      const tokens = free ? maximum : Math.min(maximum, (t.limits as Limits).outputTokens - t.usage.outputTokens);
      if (
        !free &&
        (t.usage.modelCalls >= (t.limits as Limits).modelCalls ||
          tokens <= 0 ||
          ((t.limits as Limits).resourceUnits !== undefined &&
            t.usage.resourceUnits + 1 > (t.limits as Limits).resourceUnits!))
      ) {
        throw new RuntimeFault("BUDGET_EXHAUSTED");
      }
      t.usage.modelCalls = counted(t.usage.modelCalls + 1);
      t.usage.resourceUnits = counted(t.usage.resourceUnits + 1);
      t.usage.outputTokens = counted(t.usage.outputTokens + tokens);
      if (free) t.usage.reservedOutputTokens = counted(t.usage.reservedOutputTokens + tokens);
      return tokens;
    };
    const settle = (reserved: number, actual: number, input = 0): void => {
      assertOwner();
      const t = entry();
      if (
        !Number.isSafeInteger(reserved) ||
        reserved < 1 ||
        !Number.isSafeInteger(actual) ||
        actual < 0 ||
        (!uncapped(t.limits) && actual > reserved)
      ) {
        throw new RuntimeFault("BUDGET_EXHAUSTED");
      }
      t.usage.outputTokens = counted(t.usage.outputTokens - reserved + actual);
      if (uncapped(t.limits)) {
        t.usage.inputTokens = counted(t.usage.inputTokens + counted(input));
        t.usage.reservedOutputTokens = counted(t.usage.reservedOutputTokens - reserved);
      }
    };
    return {
      // snapshot 不验 owner:同步读内存权威值(单例互斥下内存即真相)
      snapshot: () => ({ ...entry().usage }),
      reserveModel: async () =>
        mutate(() => reserve()),
      reserveModelUpTo: async (maximum: number) =>
        mutate(() => reserve(maximum)),
      settleModel: async (reserved: number, actual: number) =>
        mutate(() => {
          settle(reserved, actual);
        }),
      settleModelUsage: async (reserved: number, usage: { inputTokens: number; outputTokens: number }) =>
        mutate(() => {
          settle(reserved, usage.outputTokens, usage.inputTokens);
        }),
      reserveTool: async (units: number) =>
        mutate(() => {
          assertOwner();
          counted(units);
          const t = entry();
          const lim = t.limits as Limits;
          if (
            !uncapped(t.limits) &&
            (t.usage.toolCalls >= lim.toolCalls ||
              (lim.resourceUnits !== undefined && t.usage.resourceUnits + units > lim.resourceUnits))
          ) {
            throw new RuntimeFault("BUDGET_EXHAUSTED");
          }
          t.usage.toolCalls = counted(t.usage.toolCalls + 1);
          t.usage.resourceUnits = counted(t.usage.resourceUnits + units);
        }),
      release: async (activeMs: number) =>
        mutate(() => {
          assertOwner();
          const t = entry();
          t.usage.activeMs = counted(t.usage.activeMs + counted(activeMs));
          delete t.owner;
        }),
    } as unknown as BudgetLease;
  }

  private async claimTask(
    taskId: string,
    runId: string,
    configuration: string,
    limits: Limits | UncappedLimits,
  ): Promise<BudgetLease> {
    validateLimits(limits);
    return this.run(async () => {
      this.ensureLoaded();
      let task = this.tasks![taskId];
      if (!task) {
        task = { configuration, limits: { ...limits }, usage: zeroUsage(limits) };
        this.tasks![taskId] = task;
      }
      if (task.configuration !== configuration) throw configurationChangedFault(task, limits);
      if (task.owner) {
        // R1-2:接管判定替换 TASK_BUSY 分支——owner 进程判死(含 pid 复用)→清 owner 保 usage;
        // 判活(含本进程在役)→ TASK_BUSY。含糊一律按活(可忍)。
        const sameProcessLive = task.owner.pid === process.pid && !isLockOwnerDead(task.owner.pid, task.owner.bootId);
        if (!sameProcessLive && isLockOwnerDead(task.owner.pid, task.owner.bootId)) {
          delete task.owner; // 接管:保留 usage(含未结算预留)
        } else {
          throw new RuntimeFault("TASK_BUSY");
        }
      }
      if (!uncapped(task.limits) && task.usage.activeMs >= (task.limits as Limits).wallTimeMs) {
        throw new RuntimeFault("BUDGET_EXHAUSTED");
      }
      task.owner = { runId, pid: process.pid, bootId: processBootId(), acquiredAt: new Date().toISOString() };
      this.persist();
      return this.lease(taskId, runId);
    });
  }

  claim(taskId: string, runId: string, configuration: string, limits: Limits): Promise<BudgetLease> {
    return this.claimTask(taskId, runId, configuration, limits);
  }

  async claimUncapped(
    taskId: string,
    runId: string,
    configuration: string,
    limits: UncappedLimits,
  ): Promise<UncappedBudgetLease> {
    return (await this.claimTask(taskId, runId, configuration, limits)) as UncappedBudgetLease;
  }

  /** 仅供测试/披露:账本文件路径。 */
  get filePath(): string {
    return this.file;
  }
}

// 路径级进程单例:同 absPath 永不重建实例(KA2——重建=并发丢账);跨进程由打开处 O_EXCL 收口
const singletons = new Map<string, FileBudgetStore>();

export function getBudgetStore(dataDir: string, maxTasks = 100_000): FileBudgetStore {
  const abs = resolve(dataDir);
  let store = singletons.get(abs);
  if (store === undefined) {
    mkdirSync(abs, { recursive: true }); // 惰性创建(锁/账本/审计同目录)
    store = new FileBudgetStore(abs, maxTasks);
    singletons.set(abs, store);
  }
  return store;
}
