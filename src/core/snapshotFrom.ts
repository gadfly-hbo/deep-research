import type { SourceSnapshot } from "../contracts.js";

/**
 * SourceSnapshot 字面量集中构造(P0-1 T6)。
 * 只做构造集中:id/title/tier 的推导是调用点语义(tierOfSource 依赖模块配置、
 * docType 判定依赖来源记录),不进本函数;fetchedAt 五处同一表达式,集中于此,
 * now 注入点仅供单测确定化(缺省取当前时,行为不变)。
 */
export function snapshotFrom(input: {
  id: string;
  url: string;
  title: string;
  bodyText: string;
  parseStatus: "ok" | "failed";
  contentType: string;
  tier?: "A" | "B" | "C";
  now?: string;
}): SourceSnapshot {
  const { now, ...rest } = input;
  return { ...rest, fetchedAt: now ?? new Date().toISOString() };
}
