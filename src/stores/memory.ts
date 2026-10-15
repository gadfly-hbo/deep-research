import type { ResearchResultBundle, ResearchRun, SourceSnapshot } from "../contracts.js";
import type { Checkpoint, InvestigationEvent, ResearchStore } from "./types.js";

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
  const investigations = new Map<string, InvestigationEvent[]>();
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
    readBundle: async (runId) => bundles.find((b) => b.runId === runId) ?? null,
    appendInvestigation: async (runId, event) => {
      const list = investigations.get(runId) ?? [];
      const full: InvestigationEvent = {
        seq: list.length > 0 ? list[list.length - 1].seq + 1 : 1,
        at: new Date().toISOString(),
        ...event,
      };
      list.push(full);
      investigations.set(runId, list);
      return full;
    },
    readInvestigation: async (runId, sinceSeq = 0, limit = Number.MAX_SAFE_INTEGER) =>
      (investigations.get(runId) ?? []).filter((e) => e.seq > sinceSeq).slice(0, limit),
    runs: () => [...runs],
    bundles: () => [...bundles],
    snapshots: () => [...snapshots],
  };
}
