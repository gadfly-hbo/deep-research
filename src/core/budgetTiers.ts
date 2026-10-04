import type { Budget } from "../contracts.js";

/** 预算档位:UI 只传档位名,数值在服务端统一解析;显式 request.budget 仍可覆盖档位。 */
export type BudgetTier = "low" | "medium" | "high";

/**
 * 交互运行三档预算(2026-10-04 与用户确认,整体对标竞品深度研究量级):
 * Kimi 深度研究每任务规划 74 关键词/发现 206 网址,Gemini Deep Research 约 80-160 次搜索/浏览 100+ 页。
 * maxWallMs 留足余量:单次模型调用可达 200s,墙顶触发 capped 会直接导致有限交付,不宜贴着预估耗时设。
 * maxCostEstimate 沿用流水线默认(实测 12 次抓取成本 ≈0.05,远低于上限,不构成实际约束)。
 */
export const BUDGET_TIERS: Record<BudgetTier, Partial<Budget>> = {
  low: { maxSearches: 8, maxFetches: 12, maxWallMs: 15 * 60_000 },
  medium: { maxSearches: 40, maxFetches: 80, maxWallMs: 40 * 60_000 },
  high: { maxSearches: 100, maxFetches: 300, maxWallMs: 90 * 60_000 },
};

export function tierBudget(tier: BudgetTier): Partial<Budget> {
  return BUDGET_TIERS[tier] ?? {};
}
