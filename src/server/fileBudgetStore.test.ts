import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeFault, createRuntime, type ModelConfig, type ModelReply, type ModelTransport, type UncappedLimits, type Limits } from "pi-agent-runtime";
import { getBudgetStore } from "./fileBudgetStore.js";
import { processBootId } from "./lockfile.js";

/** P2-3b T1 红队清单:原子写/并发零丢/接管/存活拒绝/含糊判活/CONFIG 两级/snapshot 不变式/FIFO/残 tmp/SDK 兼容。 */

const tmp = (): string => mkdtempSync(join(tmpdir(), "dr-budget-"));

/** 断言被拒并取回 RuntimeFault(含 detail)。 */
const faultOf = async (p: Promise<unknown>): Promise<RuntimeFault & { detail?: string }> => {
  try {
    await p;
  } catch (e) {
    return e as RuntimeFault & { detail?: string };
  }
  throw new Error("期望调用被拒,实际成功");
};

const deadPid = (): number => {
  const child = spawnSync("sleep", ["0.3"]);
  return child.pid ?? -1;
};

const aliveChild = (): { pid: number; bootId: number; kill(): void } => {
  const child = spawn("sleep", ["10"]);
  const out = spawnSync(
    process.execPath,
    ["-e", "console.log(Math.round(Date.now() - process.uptime() * 1000))"],
    { encoding: "utf-8" },
  );
  return { pid: child.pid ?? -1, bootId: Number(out.stdout.trim()), kill: () => child.kill("SIGKILL") };
};

const UNLIMITED: UncappedLimits = {
  cumulative: "unlimited",
  maxOutputTokens: 1000,
  modelTimeoutMs: 30_000,
  toolTimeoutMs: 30_000,
  controlTimeoutMs: 30_000,
};
const CAPPED: Limits = { modelCalls: 5, toolCalls: 5, outputTokens: 1000, wallTimeMs: 60_000 };

/** 直写一份带 owner 的账本文件(伪造他进程持有)。 */
const seedTask = (
  dir: string,
  taskId: string,
  over: { owner?: { runId: string; pid: number; bootId: number }; usage?: Record<string, number>; configuration?: string },
): void => {
  const file = join(dir, "model-budget.json");
  const base = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as { tasks: Record<string, unknown> }) : { tasks: {} };
  base.tasks[taskId] = {
    configuration: over.configuration ?? "cfg-a",
    limits: UNLIMITED,
    usage: { modelCalls: 0, toolCalls: 0, outputTokens: 0, resourceUnits: 0, activeMs: 0, inputTokens: 0, reservedOutputTokens: 0, ...(over.usage ?? {}) },
    ...(over.owner ? { owner: { ...over.owner, acquiredAt: new Date().toISOString() } } : {}),
  };
  writeFileSync(file, JSON.stringify({ version: 1, tasks: base.tasks }));
};

describe("FileBudgetStore(P2-3b T1)", () => {
  it("原子写回读:claim→reserve→settle 落盘;文件拷贝=重启,懒加载后 usage 延续", async () => {
    const dir = tmp();
    const store = getBudgetStore(dir);
    const lease = await store.claimUncapped("t1", "r1", "cfg-a", UNLIMITED);
    expect(await lease.reserveModelUpTo(100)).toBe(100);
    await lease.settleModelUsage(100, { inputTokens: 30, outputTokens: 80 });
    await lease.release(1200);
    const onDisk = JSON.parse(readFileSync(join(dir, "model-budget.json"), "utf-8"));
    expect(onDisk.tasks.t1.usage).toMatchObject({ modelCalls: 1, outputTokens: 80, inputTokens: 30, activeMs: 1200 });
    expect(onDisk.tasks.t1.owner).toBeUndefined();

    // 模拟重启:拷贝账本到新目录(锁文件不拷),新 store 懒加载延续账目
    const dir2 = tmp();
    copyFileSync(join(dir, "model-budget.json"), join(dir2, "model-budget.json"));
    const store2 = getBudgetStore(dir2);
    const lease2 = await store2.claimUncapped("t1", "r2", "cfg-a", UNLIMITED);
    expect(lease2.snapshot()).toMatchObject({ modelCalls: 1, outputTokens: 80, inputTokens: 30, activeMs: 1200 });
  });

  it("并发零丢更新:同路径单例串行,双任务交错 claim-reserve-settle 计量完整", async () => {
    const dir = tmp();
    const store = getBudgetStore(dir);
    const [a, b] = await Promise.all([
      store.claimUncapped("ta", "ra", "cfg-a", UNLIMITED),
      store.claimUncapped("tb", "rb", "cfg-b", UNLIMITED),
    ]);
    await Promise.all([
      (async () => {
        for (let i = 0; i < 20; i++) {
          expect(await a.reserveModelUpTo(5)).toBe(5);
          await a.settleModelUsage(5, { inputTokens: 1, outputTokens: 5 });
        }
      })(),
      (async () => {
        for (let i = 0; i < 20; i++) {
          expect(await b.reserveModelUpTo(3)).toBe(3);
          await b.settleModelUsage(3, { inputTokens: 1, outputTokens: 3 });
        }
      })(),
    ]);
    expect(a.snapshot()).toMatchObject({ modelCalls: 20, outputTokens: 100 });
    expect(b.snapshot()).toMatchObject({ modelCalls: 20, outputTokens: 60 });
    const onDisk = JSON.parse(readFileSync(join(dir, "model-budget.json"), "utf-8"));
    expect(onDisk.tasks.ta.usage.modelCalls).toBe(20);
    expect(onDisk.tasks.tb.usage.modelCalls).toBe(20);
  });

  it("租约接管:死 owner → 接管保留 usage(含未结算预留);同进程在役 → TASK_BUSY", async () => {
    const dir = tmp();
    const store = getBudgetStore(dir);
    const pid = deadPid();
    seedTask(dir, "t-dead", {
      owner: { runId: "r-old", pid, bootId: Date.now() },
      usage: { modelCalls: 2, outputTokens: 50, reservedOutputTokens: 20, inputTokens: 7 },
    });
    const lease = await store.claimUncapped("t-dead", "r-new", "cfg-a", UNLIMITED);
    // 接管保留 usage(未结算预留 20 也在)
    expect(lease.snapshot()).toMatchObject({ modelCalls: 2, outputTokens: 50, reservedOutputTokens: 20, inputTokens: 7 });
    // 本进程在役(runId 不同)→ TASK_BUSY
    await expect(store.claimUncapped("t-dead", "r-other", "cfg-a", UNLIMITED)).rejects.toMatchObject({ reason: "TASK_BUSY" });
    await lease.release(0);
  });

  it("存活 owner 拒绝:真实他进程 pid+真实 bootId → TASK_BUSY;pid 复用(bootId 偏差>2s)→ 接管", async () => {
    const dir = tmp();
    const store = getBudgetStore(dir);
    const child = aliveChild();
    try {
      seedTask(dir, "t-alive", { owner: { runId: "r-x", pid: child.pid, bootId: child.bootId } });
      await expect(store.claimUncapped("t-alive", "r-new", "cfg-a", UNLIMITED)).rejects.toMatchObject({ reason: "TASK_BUSY" });
      // 含糊/复用:同 pid 但记录 bootId 偏差 10s → 判死接管(旧进程已退,pid 被复用)
      const dir2 = tmp();
      const store2 = getBudgetStore(dir2);
      seedTask(dir2, "t-reuse", { owner: { runId: "r-x", pid: child.pid, bootId: child.bootId - 10_000 } });
      const lease = await store2.claimUncapped("t-reuse", "r-new", "cfg-a", UNLIMITED);
      await lease.release(0);
    } finally {
      child.kill();
    }
  });

  it("CONFIGURATION_CHANGED 两级文案(R1-3):limits 字段点名;指纹泛报;出路恒定", async () => {
    const dir = tmp();
    const store = getBudgetStore(dir);
    const lease = await store.claimUncapped("t-cfg", "r1", "cfg-a", UNLIMITED);
    await lease.release(0);
    // (a) limits 变化:SDK 侧 configurationId 摘要随之变化——用不同摘要串模拟;文案逐字段点名
    const changed = { ...UNLIMITED, maxOutputTokens: 2000 };
    const errA = await faultOf(store.claimUncapped("t-cfg", "r1", "cfg-a-v2", changed));
    expect(errA.reason).toBe("CONFIGURATION_CHANGED");
    expect(errA.detail).toContain("maxOutputTokens");
    expect(errA.detail).toContain("1000");
    expect(errA.detail).toContain("resume");
    // (b) limits 未变、configuration 摘要变化:指纹泛报
    const errB = await faultOf(store.claimUncapped("t-cfg", "r1", "cfg-b", UNLIMITED));
    expect(errB.reason).toBe("CONFIGURATION_CHANGED");
    expect(errB.detail).toContain("指纹");
    expect(errB.detail).not.toContain("≠");
  });

  it("lease 矩阵(R1-2):uncapped reserveModel 抛 INVALID_REQUEST/UpTo 恰等;capped min 剩余;release 后全方法 TASK_BUSY", async () => {
    const dir = tmp();
    const store = getBudgetStore(dir);
    const uLease = await store.claimUncapped("t-matrix-u", "r1", "cfg", UNLIMITED);
    await expect(uLease.reserveModel()).rejects.toMatchObject({ reason: "INVALID_REQUEST" });
    expect(await uLease.reserveModelUpTo(77)).toBe(77); // 恰等入参
    // snapshot 不变式:reserved ≤ output 且非负
    const snap = uLease.snapshot() as { outputTokens: number; reservedOutputTokens: number };
    expect(snap.reservedOutputTokens).toBe(77);
    expect(snap.reservedOutputTokens).toBeLessThanOrEqual(snap.outputTokens);
    await uLease.settleModelUsage(77, { inputTokens: 5, outputTokens: 77 });
    await uLease.reserveTool(2);
    await uLease.release(10);
    // release 后:owner 清空,lease 方法 TASK_BUSY;同 taskId 可再 claim
    await expect(uLease.reserveModelUpTo(5)).rejects.toMatchObject({ reason: "TASK_BUSY" });
    await expect(uLease.settleModel(5, 5)).rejects.toMatchObject({ reason: "TASK_BUSY" });
    await expect(uLease.reserveTool(1)).rejects.toMatchObject({ reason: "TASK_BUSY" });

    const cStore = getBudgetStore(tmp());
    const cLease = await cStore.claim("t-matrix-c", "r1", "cfg", { ...CAPPED, outputTokens: 100 });
    const cappedReserve = cLease.reserveModelUpTo!; // BudgetLease 上为可选扩展;本 store 恒提供
    expect(await cappedReserve(500)).toBe(100); // capped:min(入参, 剩余)
    await expect(cStore.claim("t-matrix-c", "r2", "cfg", CAPPED)).rejects.toMatchObject({ reason: "TASK_BUSY" });
    await cLease.release(0);
  });

  it("capped 剩余耗尽:settle 后余量精确,reserve 超余量 → BUDGET_EXHAUSTED", async () => {
    const store = getBudgetStore(tmp());
    const lease = await store.claim("t-cap", "r1", "cfg", { ...CAPPED, outputTokens: 100 });
    const cappedReserve = lease.reserveModelUpTo!;
    expect(await cappedReserve(60)).toBe(60);
    await lease.settleModel(60, 40); // 剩余 100-40=60
    expect(await cappedReserve(90)).toBe(60); // min(90, 剩余 60)
    await expect(cappedReserve(500)).rejects.toMatchObject({ reason: "BUDGET_EXHAUSTED" });
  });

  it("FIFO:超上限剪最老已释放(owner 在役不剪)", async () => {
    const dir = tmp();
    const store = getBudgetStore(dir, 3);
    const held = await store.claimUncapped("t-hold", "r1", "cfg", UNLIMITED); // 在役:不剪
    for (let i = 0; i < 5; i++) {
      const l = await store.claimUncapped(`t-old-${i}`, `r${i}`, "cfg", UNLIMITED);
      await l.release(1);
    }
    const onDisk = JSON.parse(readFileSync(join(dir, "model-budget.json"), "utf-8")) as {
      tasks: Record<string, unknown>;
    };
    const ids = Object.keys(onDisk.tasks);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("t-hold");
    expect(ids).toContain("t-old-4"); // 最新的保留
    expect(ids).not.toContain("t-old-0"); // 最老已释放被剪
    await held.release(0);
  });

  it("崩溃注入:残 tmp 文件不阻碍重开(主文件完整可读)", async () => {
    const dir = tmp();
    const store = getBudgetStore(dir);
    const lease = await store.claimUncapped("t-crash", "r1", "cfg", UNLIMITED);
    await lease.reserveModelUpTo(10);
    // 伪造写一半崩溃:留下残 tmp
    writeFileSync(join(dir, "model-budget.json.tmp"), '{"version":1,"tasks":{"partial":');
    const lease2 = await store.claimUncapped("t-crash2", "r1", "cfg", UNLIMITED); // 重开可继续
    await lease2.reserveModelUpTo(5);
    expect(lease2.snapshot().modelCalls).toBe(1);
    await lease.release(0);
    await lease2.release(0);
  });

  it("锁收口:同路径第二实例=同单例;账本/锁文件落在 dataDir 根", async () => {
    const dir = tmp();
    const a = getBudgetStore(dir);
    const b = getBudgetStore(dir);
    expect(a).toBe(b); // 路径级进程单例
    expect(existsSync(join(dir, ".model-budget-lock"))).toBe(true);
    expect(a.filePath).toBe(join(dir, "model-budget.json"));
  });
});

describe("SDK 合同兼容(P2-3b T1 验收)", () => {
  const MODEL: ModelConfig = {
    provider: "minimax-cn",
    id: "MiniMax-M3",
    protocol: "anthropic-messages",
    endpoint: "https://api.minimaxi.com/anthropic",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    input: ["text"],
  };

  it("createRuntime + FileBudgetStore 跑一条 runText 全链(uncapped)不 STATE_FAILED,账目落盘", async () => {
    const dir = tmp();
    const reply = (text: string): ModelReply => ({ content: [{ kind: "text", text }], stop: "complete", usage: { inputTokens: 10, outputTokens: 12 } });
    const transport: ModelTransport = async () => reply('{"ok":true}');
    const auditPath = join(dir, "model-audit.jsonl");
    const runtime = createRuntime({
      model: MODEL,
      transport,
      authorize: async () => true,
      audit: { append: async () => {} },
      budgets: getBudgetStore(dir),
    });
    const result = await runtime.runText({
      taskId: "dr:sdk-compat:1",
      prompt: "测试一句话",
      limits: UNLIMITED,
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error("unreachable");
    expect(result.value).toBe('{"ok":true}');
    expect(result.usage.modelCalls).toBe(1);
    const onDisk = JSON.parse(readFileSync(join(dir, "model-budget.json"), "utf-8"));
    expect(onDisk.tasks["dr:sdk-compat:1"].usage.modelCalls).toBe(1);
    expect(onDisk.tasks["dr:sdk-compat:1"].usage.inputTokens).toBe(10);
    expect(existsSync(auditPath)).toBe(false); // 审计 sink 为空实现,账本独立落盘
  });

  it("同 taskId 二次 run(CONFIGURATION_CHANGED)→ blocked 而非 failed;usage 不清零", async () => {
    const dir = tmp();
    const transport: ModelTransport = async () => ({ content: [{ kind: "text", text: "x" }], stop: "complete", usage: { inputTokens: 1, outputTokens: 1 } });
    const runtime = createRuntime({
      model: MODEL,
      transport,
      authorize: async () => true,
      audit: { append: async () => {} },
      budgets: getBudgetStore(dir),
    });
    const limits: UncappedLimits = { ...UNLIMITED };
    await runtime.runText({ taskId: "dr:sdk-cfg:1", prompt: "a", limits });
    const second = await runtime.runText({
      taskId: "dr:sdk-cfg:1",
      prompt: "a",
      limits: { ...limits, maxOutputTokens: 999 }, // configuration 摘要变化
    });
    expect(second.status).toBe("blocked");
    if (second.status !== "blocked") throw new Error("unreachable");
    expect(second.reason).toBe("CONFIGURATION_CHANGED");
    // claim 期失败:lease 未建立,usageKnown=false(与内存版同形);账本文件首跑账目保留
    expect(second.usageKnown).toBe(false);
    const onDisk = JSON.parse(readFileSync(join(dir, "model-budget.json"), "utf-8"));
    expect(onDisk.tasks["dr:sdk-cfg:1"].usage.modelCalls).toBe(1);
  });

  it("两轮同 taskId 同 CONFIG 复跑:release 后 re-claim 成功(账目累计)", async () => {
    const dir = tmp();
    const transport: ModelTransport = async () => ({ content: [{ kind: "text", text: "x" }], stop: "complete", usage: { inputTokens: 1, outputTokens: 1 } });
    const runtime = createRuntime({
      model: MODEL,
      transport,
      authorize: async () => true,
      audit: { append: async () => {} },
      budgets: getBudgetStore(dir),
    });
    const limits: UncappedLimits = { ...UNLIMITED };
    const r1 = await runtime.runText({ taskId: "dr:sdk-re:1", prompt: "a", limits });
    expect(r1.status).toBe("succeeded");
    const r2 = await runtime.runText({ taskId: "dr:sdk-re:1", prompt: "a", limits });
    expect(r2.status).toBe("succeeded");
    const onDisk = JSON.parse(readFileSync(join(dir, "model-budget.json"), "utf-8"));
    expect(onDisk.tasks["dr:sdk-re:1"].usage.modelCalls).toBe(2); // 跨 run 累计
    expect(processBootId()).toBeGreaterThan(0);
  });
});
