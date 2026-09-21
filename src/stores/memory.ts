import type { ResearchResultBundle, ResearchRun, SourceSnapshot } from "../contracts.js";
import type { Checkpoint, ResearchStore } from "./types.js";

export interface MemoryStore extends ResearchStore {
  runs(): ResearchRun[];
  bundles(): ResearchResultBundle[];
  snapshots(): SourceSnapshot[];
}

export function createMemoryStore(): MemoryStore {
  const runs: ResearchRun[] = [];
  const bundles: ResearchResultBundle[] = [];
  const snapshots: SourceSnapshot[] = [];
  const checkpoints: Checkpoint[] = [];
  return {
    saveRun: async (run) => {
      const idx = runs.findIndex((r) => r.id === run.id);
      if (idx >= 0) runs[idx] = run;
      else runs.push(run);
    },
    saveBundle: async (bundle) => {
      bundles.push(bundle);
    },
    saveSnapshot: async (snapshot) => {
      snapshots.push(snapshot);
    },
    saveCheckpoint: async (checkpoint) => {
      checkpoints.push(checkpoint);
    },
    checkpoints: async (runId) => checkpoints.filter((c) => c.runId === runId),
    findRunByRequestId: async (requestId) => runs.find((r) => r.requestId === requestId),
    runs: () => [...runs],
    bundles: () => [...bundles],
    snapshots: () => [...snapshots],
  };
}
