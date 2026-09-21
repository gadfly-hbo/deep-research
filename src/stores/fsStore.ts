import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ResearchRequest, ResearchResultBundle, ResearchRun, SourceSnapshot } from "../contracts.js";
import type { Checkpoint, ResearchStore } from "./types.js";

export interface VersionEntry {
  version: number;
  runId: string;
  publishedAt: string;
  diffSummary?: unknown;
}

export interface ProjectMeta {
  id: string;
  module: "brand" | "industry";
  goal: string;
  scope: { summary: string; queries: string[] };
  createdAt: string;
  updatedAt: string;
  versions: VersionEntry[];
}

export class FsProjectStore implements ResearchStore {
  private constructor(readonly dir: string, private projectMeta: ProjectMeta) {}

  static create(
    dir: string,
    input: { module: "brand" | "industry"; goal: string; scope: { summary: string; queries: string[] } },
  ): FsProjectStore {
    if (existsSync(join(dir, "project.json"))) {
      throw new Error(`项目已存在: ${dir}`);
    }
    mkdirSync(join(dir, "runs"), { recursive: true });
    mkdirSync(join(dir, "reports"), { recursive: true });
    mkdirSync(join(dir, "requests"), { recursive: true });
    const now = new Date().toISOString();
    const meta: ProjectMeta = {
      id: dir.split("/").pop() ?? dir,
      module: input.module,
      goal: input.goal,
      scope: input.scope,
      createdAt: now,
      updatedAt: now,
      versions: [],
    };
    const store = new FsProjectStore(dir, meta);
    store.writeJson("project.json", meta);
    store.audit("project-created", { module: input.module, goal: input.goal });
    return store;
  }

  static open(dir: string): FsProjectStore {
    const path = join(dir, "project.json");
    if (!existsSync(path)) {
      throw new Error(`项目不存在: ${dir}`);
    }
    const meta = JSON.parse(readFileSync(path, "utf8")) as ProjectMeta;
    return new FsProjectStore(dir, meta);
  }

  meta(): ProjectMeta {
    return { ...this.projectMeta, versions: [...this.projectMeta.versions] };
  }

  saveMeta(patch: Partial<ProjectMeta>): void {
    this.projectMeta = { ...this.projectMeta, ...patch, updatedAt: new Date().toISOString() };
    this.writeJson("project.json", this.projectMeta);
  }

  audit(event: string, data: unknown): void {
    appendFileSync(
      join(this.dir, "audit.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), event, data }) + "\n",
    );
  }

  private writeJson(rel: string, value: unknown): void {
    writeFileSync(join(this.dir, rel), JSON.stringify(value, null, 2));
  }

  private readJson<T>(rel: string, fallback: T): T {
    const path = join(this.dir, rel);
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  async saveRun(run: ResearchRun): Promise<void> {
    mkdirSync(join(this.dir, "runs", run.id), { recursive: true });
    this.writeJson(join("runs", run.id, "run.json"), run);
    this.audit("run-finished", { runId: run.id, requestId: run.requestId, status: run.status, usage: run.usage });
  }

  async saveBundle(bundle: ResearchResultBundle): Promise<void> {
    mkdirSync(join(this.dir, "runs", bundle.runId), { recursive: true });
    this.writeJson(join("runs", bundle.runId, "bundle.json"), bundle);
    this.audit("bundle-saved", { runId: bundle.runId, claims: bundle.claims.length, evidence: bundle.evidence.length });
  }

  async saveSnapshot(snapshot: SourceSnapshot): Promise<void> {
    const all = this.readJson<Record<string, SourceSnapshot>>("snapshots.json", {});
    all[snapshot.id] = snapshot;
    this.writeJson("snapshots.json", all);
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    mkdirSync(join(this.dir, "runs", checkpoint.runId), { recursive: true });
    const rel = join("runs", checkpoint.runId, "checkpoints.json");
    const all = this.readJson<Checkpoint[]>(rel, []);
    all.push(checkpoint);
    this.writeJson(rel, all);
  }

  async checkpoints(runId: string): Promise<Checkpoint[]> {
    return this.readJson<Checkpoint[]>(join("runs", runId, "checkpoints.json"), []);
  }

  async findRunByRequestId(requestId: string): Promise<ResearchRun | undefined> {
    const runsDir = join(this.dir, "runs");
    if (!existsSync(runsDir)) return undefined;
    for (const runId of readdirSync(runsDir)) {
      const run = this.readJson<ResearchRun | null>(join("runs", runId, "run.json"), null);
      if (run?.requestId === requestId) return run;
    }
    return undefined;
  }

  async readBundle(runId: string): Promise<ResearchResultBundle | null> {
    return this.readJson<ResearchResultBundle | null>(join("runs", runId, "bundle.json"), null);
  }

  async listSnapshots(): Promise<SourceSnapshot[]> {
    return Object.values(this.readJson<Record<string, SourceSnapshot>>("snapshots.json", {}));
  }

  async saveRequest(request: ResearchRequest): Promise<void> {
    if (!request.id) throw new Error("request.id 缺失,无法持久化请求");
    mkdirSync(join(this.dir, "requests"), { recursive: true });
    this.writeJson(join("requests", `${request.id}.json`), request);
  }

  async readRequest(requestId: string): Promise<ResearchRequest | null> {
    return this.readJson<ResearchRequest | null>(join("requests", `${requestId}.json`), null);
  }

  async listRuns(): Promise<ResearchRun[]> {
    const runsDir = join(this.dir, "runs");
    if (!existsSync(runsDir)) return [];
    const runs: ResearchRun[] = [];
    for (const runId of readdirSync(runsDir)) {
      const run = this.readJson<ResearchRun | null>(join("runs", runId, "run.json"), null);
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => a.id.localeCompare(b.id));
  }
}
