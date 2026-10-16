import { describe, expect, it, vi } from "vitest";
import type { Intervention } from "../contracts.js";
import { RunRegistry } from "./runRegistry.js";

// P1-3 T1:RunRegistry 单测。Registry 纯内存无 I/O,无需文件系统。

const mkIntervention = (id: string): Intervention => ({
  id,
  submittedAt: "2026-01-01T00:00:00.000Z",
  instruction: { type: "skip-question", questionId: "q1" },
});

describe("RunRegistry 双键空间", () => {
  it("同一字符串作为 requestId 与 runId 互不干扰", () => {
    const registry = new RunRegistry();
    registry.acquire("same-key");
    registry.enqueue("same-key", mkIntervention("ins:1"));

    // cancel 只命中键空间 A(controller),不动键空间 B(指令队列)
    expect(registry.cancel("same-key")).toBe(true);
    expect(registry.pendingCount("same-key")).toBe(1);

    // 反向:enqueue/drain 不创造也不触碰 controller
    const fresh = new RunRegistry();
    fresh.enqueue("only-queue", mkIntervention("ins:2"));
    expect(fresh.cancel("only-queue")).toBe(false);
    fresh.release("only-queue");
    expect(fresh.pendingCount("only-queue")).toBe(1);
  });

  it("acquire 返回新 AbortController;cancel 不 release,重复 cancel 仍命中", () => {
    const registry = new RunRegistry();
    const controller = registry.acquire("r1");
    expect(controller).toBeInstanceOf(AbortController);
    expect(controller.signal.aborted).toBe(false);

    expect(registry.cancel("r1")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    // 现状语义:cancel 只 abort 不 delete,路由 finally 中的 release 才移除
    expect(registry.cancel("r1")).toBe(true);

    registry.release("r1");
    expect(registry.cancel("r1")).toBe(false);
  });

  it("cancel 原样键透传:未注册返回 false,含 undefined/未知字符串", () => {
    const registry = new RunRegistry();
    registry.acquire("r-known");
    expect(registry.cancel("r-unknown")).toBe(false);
    expect(registry.cancel(undefined)).toBe(false);
    expect(registry.cancel("")).toBe(false);
  });

  it("cancel 触发 abort 事件", () => {
    const registry = new RunRegistry();
    const controller = registry.acquire("r-evt");
    const onAbort = vi.fn();
    controller.signal.addEventListener("abort", onAbort);
    expect(registry.cancel("r-evt")).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});

describe("RunRegistry 指令队列", () => {
  it("enqueue/pendingCount 计数:未知 runId 为 0,逐次入队返回新长度", () => {
    const registry = new RunRegistry();
    expect(registry.pendingCount("run-x")).toBe(0);
    expect(registry.enqueue("run-x", mkIntervention("ins:1"))).toBe(1);
    expect(registry.enqueue("run-x", mkIntervention("ins:2"))).toBe(2);
    expect(registry.enqueue("run-x", mkIntervention("ins:3"))).toBe(3);
    expect(registry.pendingCount("run-x")).toBe(3);
    // 不同 run.id 互不影响
    expect(registry.pendingCount("run-y")).toBe(0);
  });

  it("drain 清空语义:按序取空,第二次 drain 为空;未知 runId 为空", () => {
    const registry = new RunRegistry();
    expect(registry.drain("run-x")).toEqual([]);
    registry.enqueue("run-x", mkIntervention("ins:1"));
    registry.enqueue("run-x", mkIntervention("ins:2"));
    const drained = registry.drain("run-x");
    expect(drained.map((i) => i.id)).toEqual(["ins:1", "ins:2"]);
    expect(registry.pendingCount("run-x")).toBe(0);
    expect(registry.drain("run-x")).toEqual([]);
  });

  it("restoreFromDisk:safeParse 过滤——合法入队、非法丢弃,返回成功入队数", () => {
    const registry = new RunRegistry();
    const restored = registry.restoreFromDisk("run-x", [
      mkIntervention("ins:ok1"),
      { foo: "bar" },
      { id: "ins:bad", submittedAt: "2026-01-01T00:00:00.000Z", instruction: { type: "nope" } },
      mkIntervention("ins:ok2"),
      "not-an-object",
    ]);
    expect(restored).toBe(2);
    expect(registry.pendingCount("run-x")).toBe(2);
    expect(registry.drain("run-x").map((i) => i.id)).toEqual(["ins:ok1", "ins:ok2"]);
  });

  it("snapshot 返回防御性拷贝:内容等于当前队列,改返回值不影响内部", () => {
    const registry = new RunRegistry();
    expect(registry.snapshot("run-x")).toEqual([]);
    registry.enqueue("run-x", mkIntervention("ins:1"));
    const snap = registry.snapshot("run-x");
    expect(snap.map((i) => i.id)).toEqual(["ins:1"]);
    snap.push(mkIntervention("ins:evil"));
    expect(registry.pendingCount("run-x")).toBe(1);
  });
});

describe("RunRegistry 加注键空间与问内注入(P2-6)", () => {
  it("registerBudget/budgetOf/unregisterBudget 生命周期:同对象引用透传", () => {
    const registry = new RunRegistry();
    const budget = { maxSearches: 10, maxFetches: 20, maxWallMs: 1000, maxParallel: 4 };
    registry.registerBudget("run-b", budget);
    expect(registry.budgetOf("run-b")).toBe(budget); // 同一引用(原地变异生效的前提)
    budget.maxSearches += 5;
    expect(registry.budgetOf("run-b")!.maxSearches).toBe(15);
    registry.unregisterBudget("run-b");
    expect(registry.budgetOf("run-b")).toBeUndefined();
  });

  it("takeRefinement filtered take:仅取 refine-direction(多次按序),skip/add 留队,空队列 null", () => {
    const registry = new RunRegistry();
    expect(registry.takeRefinement("run-t")).toBeNull(); // 无队列
    registry.enqueue("run-t", mkIntervention("ins:s"));
    registry.enqueue("run-t", { ...mkIntervention("ins-r1"), instruction: { type: "refine-direction", note: "看国内" } });
    registry.enqueue("run-t", mkIntervention("ins:a"));
    registry.enqueue("run-t", { ...mkIntervention("ins-r2"), instruction: { type: "refine-direction", note: "看出口" } });

    const first = registry.takeRefinement("run-t");
    expect(first?.id).toBe("ins-r1"); // 最早入队的 refine 先出(FIFO)
    expect(first?.instruction).toMatchObject({ type: "refine-direction", note: "看国内" });
    expect(registry.takeRefinement("run-t")?.id).toBe("ins-r2");
    expect(registry.takeRefinement("run-t")).toBeNull(); // refine 已尽:不取 skip/add

    const drained = registry.drain("run-t");
    expect(drained.map((i) => i.id)).toEqual(["ins:s", "ins:a"]); // drain 不动语义:skip/add 完整交给问间隙
  });
});

describe("RunRegistry 互斥锁(P2-3 R1-6)", () => {
  it("withGateLock 同 runId 串行:临界区不重叠;不同 runId 互不阻塞", async () => {
    const registry = new RunRegistry();
    const events: string[] = [];
    const section = (name: string, ms: number) => () =>
      new Promise<string>((resolve) => {
        events.push(`${name}:enter`);
        setTimeout(() => {
          events.push(`${name}:exit`);
          resolve(name);
        }, ms);
      });
    const [a, b] = await Promise.all([
      registry.withGateLock("run-x", section("a", 20)),
      registry.withGateLock("run-x", section("b", 1)),
    ]);
    // a 先入锁:b 的 enter 必晚于 a 的 exit(串行),完成序=a 先返回
    expect(events.slice(0, 2)).toEqual(["a:enter", "a:exit"]);
    expect(events.indexOf("b:enter")).toBeGreaterThan(events.indexOf("a:exit"));
    expect([a, b]).toEqual(["a", "b"]);
    // 不同 runId 并行:短任务先完成
    const order: string[] = [];
    await Promise.all([
      registry.withGateLock("run-y", () => new Promise((r) => setTimeout(r, 20)).then(() => order.push("y"))),
      registry.withGateLock("run-z", () => new Promise((r) => setTimeout(r, 1)).then(() => order.push("z"))),
    ]);
    expect(order).toEqual(["z", "y"]);
  });

  it("withProjectLock 同项目串行;临界区抛错不阻断后续排队者", async () => {
    const registry = new RunRegistry();
    const seen: number[] = [];
    const failing = registry.withProjectLock("p-1", async () => {
      await new Promise((r) => setTimeout(r, 10));
      seen.push(1);
      throw new Error("临界区失败");
    });
    const queued = registry.withProjectLock("p-1", async () => {
      seen.push(2);
      return "ok";
    });
    await expect(failing).rejects.toThrow("临界区失败");
    await expect(queued).resolves.toBe("ok");
    expect(seen).toEqual([1, 2]); // 失败不吞掉后续临界区
  });
});
