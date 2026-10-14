import type { Budget, ResearchRun } from "../contracts.js";

/**
 * 预算判定集中(P0-1 T7):usage 只经 usage() 读、由编排器原地累加,
 * 本类不做任何写回;state.capped 的置位与计数器写仍留在编排器原位。
 * now/startedAt 注入仅供单测确定化(缺省 Date.now 与真实起点,行为不变)。
 */
export class BudgetTracker {
  constructor(
    private readonly budget: Budget,
    private readonly usage: () => ResearchRun["usage"],
    private readonly startedAt: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 成本或墙钟任一超限。 */
  overBudget(): boolean {
    return (
      this.usage().costEstimate > this.budget.maxCostEstimate ||
      this.now() - this.startedAt > this.budget.maxWallMs
    );
  }

  /** 搜索闸门:搜索数未满且未超预算。 */
  canSearch(): boolean {
    return this.usage().searches < this.budget.maxSearches && !this.overBudget();
  }

  /** 抓取配额按剩余问题均分,下限 1(避免首个问题独占预算)。 */
  fetchQuota(remainingQuestions: number): number {
    return Math.max(
      1,
      Math.floor((this.budget.maxFetches - this.usage().fetches) / remainingQuestions),
    );
  }

  /** 本轮还能抓几篇:全局余量与本问配额取小。 */
  fetchRoom(perQuestion: number, fetchedForQ: number): number {
    return Math.min(this.budget.maxFetches - this.usage().fetches, perQuestion - fetchedForQ);
  }

  /** 本批抓完即触顶(含恰好抓满,>= 语义逐位保留)。 */
  shouldCapOnTake(takeLen: number): boolean {
    return this.usage().fetches + takeLen >= this.budget.maxFetches;
  }
}
