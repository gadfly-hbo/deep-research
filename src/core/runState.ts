import type { Claim, Evidence, SourceSnapshot } from "../contracts.js";
import { addLimitation } from "./limitations.js";
import type { AnalyzeOutput, PlanQuestion } from "./stages.js";

/**
 * runResearch 的运行时状态(P0-1 T3 迁移;checkpoint 序列化形状受此约束):
 * gather checkpoint 以 {...state} 落盘、按字段名恢复,字段增删/重命名会破坏存量 run 恢复——
 * 形状由 src/core/resumeV1.test.ts 的键白名单锁定。
 */
export interface RunState {
  questions: PlanQuestion[];
  snapshots: SourceSnapshot[];
  evidence: Evidence[];
  claims: Claim[];
  claimQuestions: Record<string, string>;
  findings: AnalyzeOutput["findings"];
  draftMd: string | null;
  limitations: string[];
  unresolved: string[];
  counterexampleChecked: boolean;
  capped: boolean;
}

export const emptyState = (): RunState => ({
  questions: [],
  snapshots: [],
  evidence: [],
  claims: [],
  claimQuestions: {},
  findings: [],
  draftMd: null,
  limitations: [],
  unresolved: [],
  counterexampleChecked: false,
  capped: false,
});

/** 阶段输出护栏:模型输出不合格时降级为缺省值并披露限制,而不是击杀整条 run(失败不冒充完成)。 */
export function safeParse<T>(
  schema: { parse: (v: unknown) => T },
  output: unknown,
  fallback: () => T,
  limitation: string,
  state: RunState,
): T {
  try {
    return schema.parse(output);
  } catch {
    addLimitation(state.limitations, limitation);
    return fallback();
  }
}
