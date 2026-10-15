import type { RunState } from "./runState.js";
import { safeParse } from "./runState.js";

/**
 * 阶段样板集中(P0-1 T9):仅 analyze / draft 两段改走本函数。
 *
 * 五段对照(抽取前的差异审计,plan/polish/rephrase 刻意保留内联):
 * | 段      | persistRun        | runStage 输入   | coerce           | apply 后动作          | saveCp 数据        |
 * |---------|-------------------|-----------------|------------------|-----------------------|--------------------|
 * | plan    | persistRun("plan")| goal/scope/框架 | 无               | questions 映射+兜底   | plan 输出          |
 * | analyze | persistRun("analyze")| 三件套       | 无               | 缺口补证 gather(1,…)  | analyze 本体       |
 * | draft   | persistRun("draft")| 含 evidencePacks| coerceDraftOutput| 无                    | { reportMd }       |
 * | polish  | persistRun("draft")| 草稿+素材包    | coerceDraftOutput| 无                    | { reportMd }       |
 * | rephrase| 无                 | 单段文本        | 无               | 无                    | 无                 |
 *
 * 差异维度 ≥7(持久化阶段名、输入形状、coerce、apply 后动作、checkpoint 数据、
 * 降级文案、缺口回环),超过抽公共helper 的阈值时只抽 analyze+draft 子集:
 * 二者共享 runStage → safeParse(降级+披露) → apply 骨架(用量计量由编排器 wrapper 统一累计),
 * 而缺口补证、checkpoint 落盘、polish 的 persistRun("draft") 时机等
 * 编排语义全部留在调用点。取消传播不进本函数(cancelled/cancelRun 只在编排器)。
 */
export interface RunStageSafeSpec<T> {
  /** runStage 调用(闭包携带阶段名/输入/callKey)。 */
  call: () => Promise<{ output: unknown }>;
  schema: { parse: (v: unknown) => T };
  /** 输出整形(如 coerceDraftOutput),缺省直解析。 */
  coerce?: (output: unknown) => unknown;
  fallback: () => T;
  limitation: string;
  state: RunState;
  /** 解析成功后写 state;缺口补证等编排动作由调用点在返回后自行衔接。 */
  apply: (parsed: T) => void | Promise<void>;
}

export async function runStageSafe<T>(spec: RunStageSafeSpec<T>): Promise<T> {
  const res = await spec.call();
  const parsed = safeParse(
    spec.schema,
    spec.coerce ? spec.coerce(res.output) : res.output,
    spec.fallback,
    spec.limitation,
    spec.state,
  );
  await spec.apply(parsed);
  return parsed;
}
