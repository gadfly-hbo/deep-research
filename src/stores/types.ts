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
}
