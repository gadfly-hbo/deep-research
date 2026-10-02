import type { ResearchResultBundle, ResearchRun, SourceSnapshot } from "../contracts.js";
import type { StageName } from "../core/stages.js";

export interface Checkpoint {
  runId: string;
  stage: StageName | "gather" | "publish";
  data: unknown;
  completedAt: string;
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
}
