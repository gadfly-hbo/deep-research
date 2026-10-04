import { describe, expect, it } from "vitest";
import { BUDGET_TIERS, tierBudget, type BudgetTier } from "./budgetTiers.js";
import { DEFAULT_BUDGET, resolveBudget } from "./runResearch.js";

describe("预算档位", () => {
  it("三档数值与 2026-10-04 确认契约一致(低 8/12、中 40/80、高 100/300)", () => {
    expect(BUDGET_TIERS.low).toMatchObject({ maxSearches: 8, maxFetches: 12 });
    expect(BUDGET_TIERS.medium).toMatchObject({ maxSearches: 40, maxFetches: 80 });
    expect(BUDGET_TIERS.high).toMatchObject({ maxSearches: 100, maxFetches: 300 });
    for (const tier of ["low", "medium", "high"] as BudgetTier[]) {
      expect(tierBudget(tier).maxWallMs).toBeGreaterThan(0);
    }
  });

  it("解析优先级:显式 budget > 档位 > 流水线默认", () => {
    expect(resolveBudget({})).toMatchObject({
      maxSearches: DEFAULT_BUDGET.maxSearches,
      maxFetches: DEFAULT_BUDGET.maxFetches,
    });
    expect(resolveBudget({ budgetTier: "medium" })).toMatchObject({ maxSearches: 40, maxFetches: 80 });
    expect(resolveBudget({ budgetTier: "medium", budget: { maxFetches: 5 } })).toMatchObject({
      maxSearches: 40,
      maxFetches: 5,
    });
  });

  it("档位只覆盖搜索/抓取/墙钟,成本与并发沿用默认(实测成本远低于上限)", () => {
    for (const tier of ["low", "medium", "high"] as BudgetTier[]) {
      const b = resolveBudget({ budgetTier: tier });
      expect(b.maxCostEstimate).toBe(DEFAULT_BUDGET.maxCostEstimate);
      expect(b.maxParallel).toBe(DEFAULT_BUDGET.maxParallel);
    }
  });
});
