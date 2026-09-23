/* 共享数据类型与标签映射:与服务端契约(src/contracts.ts)对应,仅前端展示用。 */

export type Module = "brand" | "industry";

export interface OutlineSection { id: string; title: string; purpose?: string; bullets: string[] }
export interface Outline { title: string; subtitle?: string; sections: OutlineSection[] }
export interface VersionEntry {
  version: number;
  runId: string;
  publishedAt: string;
  diffSummary?: { addedClaims: string[]; removedClaims: string[]; evidenceDelta: number };
}
export interface ProjectMeta {
  id: string;
  module: Module;
  goal: string;
  scope: { summary: string; queries: string[] };
  updatedAt: string;
  versions: VersionEntry[];
  status?: "active" | "archived";
}
export interface Run {
  id: string;
  requestId: string;
  stage: string;
  status: "running" | "cancelled" | "failed" | "published" | "limited";
  usage: { searches: number; fetches: number; costEstimate: number; wallMs: number };
  error?: string;
}
export interface Snapshot { id: string; url: string; title: string; fetchedAt: string; parseStatus: string; tier?: "A" | "B" | "C" }
export interface Claim {
  id: string;
  statement: string;
  kind: string;
  evidenceIds: string[];
  calibration?: { entity: string; period: string; unit: string; value?: number };
  confidence?: "high" | "medium" | "low";
}
export interface Verdict {
  evidenceId: string;
  verdict: string;
  entailment?: "strong" | "weak" | "fail" | "na";
  numeric?: "ok" | "mismatch" | "na";
  tier?: "A" | "B" | "C";
}
export interface Bundle {
  runId: string;
  version: number;
  reportMd: string;
  claims: Claim[];
  evidence: { id: string; snapshotId: string; quote: string }[];
  snapshots: Snapshot[];
  limitations: string[];
  unresolved: string[];
  verdicts: Verdict[];
}
export interface ProjectDetail { meta: ProjectMeta; runs: Run[]; snapshots: Snapshot[] }

/** Chip 色调 → styles.css 类名后缀 */
export type Tone = "ok" | "run" | "queue" | "wait" | "fail" | "insuf" | "agg" | "local" | "fork" | "falsi" | "plain";

export const MODULE_LABEL: Record<Module, string> = { brand: "品牌研究", industry: "行业研究" };

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "进行中", tone: "run" },
  cancelled: { label: "已取消", tone: "wait" },
  failed: { label: "已失败", tone: "fail" },
  published: { label: "已发布", tone: "ok" },
  limited: { label: "有限交付", tone: "insuf" },
};

/** 侧栏/列表状态点 */
export const STATUS_DOT: Record<string, string> = {
  running: "dot-run",
  cancelled: "dot-cancel",
  failed: "dot-fail",
  published: "dot-ok",
  limited: "dot-warn",
};

export const KIND: Record<string, { label: string; tone: Tone }> = {
  fact: { label: "事实", tone: "agg" },
  inference: { label: "推断", tone: "insuf" },
  unverified: { label: "未验证", tone: "fail" },
};

export const VERDICT: Record<string, { label: string; tone: Tone }> = {
  "quote-hit": { label: "已核实", tone: "ok" },
  "quote-mismatch": { label: "未通过", tone: "fail" },
  "snapshot-missing": { label: "快照缺失", tone: "insuf" },
};

export const CONFIDENCE: Record<string, { label: string; tone: Tone }> = {
  high: { label: "高置信", tone: "ok" },
  medium: { label: "中置信", tone: "insuf" },
  low: { label: "低置信", tone: "fail" },
};

export const TIER_BADGE: Record<string, { label: string; tone: Tone }> = {
  A: { label: "A级", tone: "ok" },
  B: { label: "B级", tone: "agg" },
  C: { label: "C级", tone: "wait" },
};

export const ENTAIL_LABEL: Record<string, string> = {
  strong: "蕴涵:强支撑",
  weak: "蕴涵:弱支撑",
  fail: "蕴涵:不支撑",
  na: "蕴涵:未评估",
};
export const NUMERIC_LABEL: Record<string, string> = {
  ok: "数值复算:一致",
  mismatch: "数值复算:不一致",
  na: "数值复算:未评估",
};

export const STAGES = [
  { key: "plan", title: "计划" },
  { key: "gather", title: "采证" },
  { key: "analyze", title: "分析" },
  { key: "draft", title: "草稿" },
  { key: "review", title: "评审" },
  { key: "publish", title: "发布" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

export const isStageKey = (s: string | undefined | null): s is StageKey =>
  s !== undefined && s !== null && STAGES.some((x) => x.key === s);

export const stageTitle = (key: string): string =>
  STAGES.find((s) => s.key === key)?.title ?? key;
