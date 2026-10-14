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
