import type { ResearchResultBundle, ResearchRun, SourceSnapshot } from "../contracts.js";
import type { StageName } from "../core/stages.js";

export interface Checkpoint {
  runId: string;
  stage: StageName | "gather" | "publish";
  data: unknown;
  completedAt: string;
}

/** P2-4(D4):调查事件侧车(不进 checkpoint);verdict=问收束事件;seq 单调(跨 resume)。 */
export interface InvestigationEvent {
  seq: number;
  qid: string;
  kind: "query" | "fetch" | "read" | "verdict";
  at: string;
  summary: string;
  sid?: string;
  url?: string;
  query?: string;
  sufficient?: boolean;
  note?: string;
}

export interface ResearchStore {
  saveRun(run: ResearchRun): Promise<void>;
  saveBundle(bundle: ResearchResultBundle): Promise<void>;
  saveSnapshot(snapshot: SourceSnapshot): Promise<void>;
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  checkpoints(runId: string): Promise<Checkpoint[]>;
  findRunByRequestId(requestId: string): Promise<ResearchRun | undefined>;
  /** 2.1:读回指定 run 的成果包(增量追问的基准复用);不存在返回 null。 */
  readBundle(runId: string): Promise<ResearchResultBundle | null>;
  /** P2-4(R1-9):追加调查事件(store 负责 seq/at);返回落盘后的完整事件。 */
  appendInvestigation(runId: string, event: Omit<InvestigationEvent, "seq" | "at">): Promise<InvestigationEvent>;
  /** P2-4(R1-9):增量读回调查事件(seq > sinceSeq,至多 limit 条)。 */
  readInvestigation(runId: string, sinceSeq?: number, limit?: number): Promise<InvestigationEvent[]>;
}
