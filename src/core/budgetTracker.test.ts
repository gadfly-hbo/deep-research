import { describe, expect, it } from "vitest";
import type { Budget, ResearchRun } from "../contracts.js";
import { BudgetTracker } from "./budgetTracker.js";

const budget: Budget = {
  maxSearches: 3,
  maxFetches: 10,
  maxWallMs: 1000,
  maxParallel: 2,
};

const makeUsage = (init: Partial<ResearchRun["usage"]> = {}) => {
  const usage: ResearchRun["usage"] = { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0, ...init };
  return usage;
};

describe("BudgetTracker", () => {
  it("overBudget:墙钟恰满不超限、超一超限(成本上限随④退役)", () => {
    const usage = makeUsage();
    let t = 1000;
    const tracker = new BudgetTracker(budget, () => usage, 0, () => t);
    expect(tracker.overBudget()).toBe(false); // 恰满 maxWallMs 不超限(> 语义)
    t = 1001;
    expect(tracker.overBudget()).toBe(true);
  });

  it("canSearch:搜索数恰满即关门,overBudget 同样关门", () => {
    const usage = makeUsage({ searches: 2 });
    const tracker = new BudgetTracker(budget, () => usage, 0, () => 0);
    expect(tracker.canSearch()).toBe(true);
    usage.searches = 3;
    expect(tracker.canSearch()).toBe(false);

    const tracker2 = new BudgetTracker(budget, () => makeUsage({ wallMs: 2000 }), 0, () => 1001);
    expect(tracker2.canSearch()).toBe(false);
  });

  it("fetchQuota:均分向下取整,Math.max(1,…) 下钳", () => {
    const usage = makeUsage({ fetches: 1 });
    const tracker = new BudgetTracker(budget, () => usage, 0, () => 0);
    expect(tracker.fetchQuota(3)).toBe(3); // floor(9/3)
    expect(tracker.fetchQuota(4)).toBe(2); // floor(9/4)
    usage.fetches = 10; // 余量 0 仍保底 1
    expect(tracker.fetchQuota(2)).toBe(1);
    usage.fetches = 12; // 超支为负同样下钳到 1
    expect(tracker.fetchQuota(2)).toBe(1);
  });

  it("fetchRoom:全局余量与本问配额取小,可为负(调用点判 <= 0)", () => {
    const usage = makeUsage({ fetches: 8 });
    const tracker = new BudgetTracker(budget, () => usage, 0, () => 0);
    expect(tracker.fetchRoom(4, 1)).toBe(2); // 全局余量 2 < 本问余 3
    expect(tracker.fetchRoom(2, 1)).toBe(1); // 本问余 1 < 全局余量 2
    usage.fetches = 10;
    expect(tracker.fetchRoom(4, 0)).toBe(0);
    usage.fetches = 11;
    expect(tracker.fetchRoom(4, 0)).toBe(-1);
  });

  it("shouldCapOnTake:恰好抓满即置顶(>= 语义),差一不置", () => {
    const usage = makeUsage({ fetches: 7 });
    const tracker = new BudgetTracker(budget, () => usage, 0, () => 0);
    expect(tracker.shouldCapOnTake(2)).toBe(false);
    expect(tracker.shouldCapOnTake(3)).toBe(true); // 7+3 恰满
    expect(tracker.shouldCapOnTake(4)).toBe(true);
  });
});
