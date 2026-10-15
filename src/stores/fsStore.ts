import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { ResearchRunSchema } from "../contracts.js";
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
  /** 归档状态:archived 不进主列表,可随时恢复;缺省视为 active */
  status?: "active" | "archived";
}

// ---- 快照布局(P0-2 D1):一文件一快照 + index.json 插入序索引 ----
// 文件名 = sha256(id) 前 16 位 hex;id 全文留文件内,原始 id 永不拼路径(KA3)。
// index.json = { order: string[] },逐位复刻旧 snapshots.json 字典的插入序语义:
// 新 id 追加末尾;同 id 覆盖写只更新文件、不动索引位置(KA2)。

const SNAPSHOT_FILE_RE = /^[0-9a-f]{16}\.json$/;
const INDEX_FILE = "index.json";

const snapshotFileName = (id: string): string =>
  createHash("sha256").update(id).digest("hex").slice(0, 16) + ".json";

interface SnapshotEntry {
  id: string;
  file: string;
  snapshot: SourceSnapshot;
}

/** 扫描快照目录:只认哈希文件名,坏文件与其余杂物(如 .DS_Store/index.json)一律跳过(R1.4c/d)。 */
const scanSnapshotDir = (dir: string): { entries: SnapshotEntry[]; corrupt: string[] } => {
  if (!existsSync(dir)) return { entries: [], corrupt: [] };
  const entries: SnapshotEntry[] = [];
  const corrupt: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!SNAPSHOT_FILE_RE.test(file)) continue;
    try {
      const snapshot = JSON.parse(readFileSync(join(dir, file), "utf8")) as SourceSnapshot;
      entries.push({ id: snapshot.id, file, snapshot });
    } catch {
      corrupt.push(file);
    }
  }
  return { entries, corrupt };
};

/** fetchedAt 升序,并列按文件名字典序(确定性 tiebreak,R1.4a)。 */
const byFetchedAt = (a: SnapshotEntry, b: SnapshotEntry): number =>
  a.snapshot.fetchedAt === b.snapshot.fetchedAt
    ? a.file.localeCompare(b.file)
    : a.snapshot.fetchedAt.localeCompare(b.snapshot.fetchedAt);

/** order 数组清洗:滤非字符串、去重(保留首次出现)(R1.4b)。 */
const cleanOrder = (order: unknown): string[] => {
  if (!Array.isArray(order)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of order) {
    if (typeof v !== "string" || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
};

interface HealedOrder {
  order: string[];
  /** 索引缺失/非法/形状错 → 全量重建。 */
  rebuilt: boolean;
  /** 自愈后与原索引不同(orphan 追加 / 缺失剔除),需静默落盘。 */
  changed: boolean;
}

const healOrder = (entries: SnapshotEntry[], rawIndex: unknown): HealedOrder => {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const raw = (rawIndex as { order?: unknown } | null)?.order;
  if (raw === undefined || !Array.isArray(raw)) {
    return { order: [...entries].sort(byFetchedAt).map((e) => e.id), rebuilt: true, changed: true };
  }
  const cleaned = cleanOrder(raw).filter((id) => byId.has(id));
  const known = new Set(cleaned);
  const orphans = entries.filter((e) => !known.has(e.id)).sort(byFetchedAt);
  const order = [...cleaned, ...orphans.map((e) => e.id)];
  const changed = order.length !== cleanOrder(raw).length || orphans.length > 0;
  return { order, rebuilt: false, changed };
};

const readIndexRaw = (dir: string): unknown => {
  const path = join(dir, INDEX_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // 非法 JSON 视同缺失(R1.4a)
  }
};

/**
 * 只读共享 helper(KA1/R1.9b):新目录权威 → 回退旧 snapshots.json(Object.values 现状序)。
 * 不迁移、不修复、不写盘——migrateLibrary 的 dryRun 语义依赖这一点。
 */
export function readProjectSnapshots(dir: string): SourceSnapshot[] {
  const newDir = join(dir, "snapshots");
  if (!existsSync(newDir)) {
    const oldPath = join(dir, "snapshots.json");
    if (!existsSync(oldPath)) return [];
    return Object.values(JSON.parse(readFileSync(oldPath, "utf8")) as Record<string, SourceSnapshot>);
  }
  const { entries } = scanSnapshotDir(newDir);
  return healOrder(entries, readIndexRaw(newDir)).order.map((id) => entries.find((e) => e.id === id)!.snapshot);
}

export class FsProjectStore implements ResearchStore {
  /** 迁移失败兜底:读写回退旧 snapshots.json 单文件格式(R1.1)。 */
  private legacySnapshots = false;

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
    // R2.1:新项目纯新格式,预建快照目录与空索引,永不触旧格式
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    store.writeJson(join("snapshots", INDEX_FILE), { order: [] });
    store.audit("project-created", { module: input.module, goal: input.goal });
    return store;
  }

  static open(dir: string): FsProjectStore {
    const path = join(dir, "project.json");
    if (!existsSync(path)) {
      throw new Error(`项目不存在: ${dir}`);
    }
    const meta = JSON.parse(readFileSync(path, "utf8")) as ProjectMeta;
    const store = new FsProjectStore(dir, meta);
    store.migrateSnapshots();
    return store;
  }

  /**
   * 存量迁移(D2,open 内同步完成——R1.3 同步签名是准入条件):
   * 新目录缺失而旧文件存在 → 先写临时目录再原子改名,旧文件改名 .bak;
   * 两者并存(迁移崩溃窗口/跨进程撞车)→ 新目录权威,补迁缺失 id 后旧文件改名 .bak(已存在则带时间戳,R1.7d);
   * 失败不动旧文件、读写回退旧格式并 audit(R1.1);全部事件留痕(R1.6)。
   */
  private migrateSnapshots(): void {
    const oldPath = join(this.dir, "snapshots.json");
    const newDir = join(this.dir, "snapshots");
    const bakPath = join(this.dir, "snapshots.json.bak");
    if (!existsSync(oldPath)) {
      // R1.7c:快照目录缺失而 .bak 在旁,只警示不自动恢复(复活会与索引不一致)
      if (!existsSync(newDir) && existsSync(bakPath)) {
        this.audit("snapshot-bak-leftover", { hint: "snapshots/ 缺失而 snapshots.json.bak 存在,恢复需人工 rename" });
      }
      return;
    }
    const bakTarget = (): string =>
      existsSync(bakPath)
        ? join(this.dir, `snapshots.json.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`)
        : bakPath;
    if (existsSync(newDir)) {
      try {
        const dict = JSON.parse(readFileSync(oldPath, "utf8")) as Record<string, SourceSnapshot>;
        let merged = 0;
        for (const [id, snap] of Object.entries(dict)) {
          if (!existsSync(join(newDir, snapshotFileName(id)))) {
            this.writeJson(join("snapshots", snapshotFileName(id)), snap);
            merged += 1;
          }
        }
        // 补迁的 orphan 由 listSnapshots 自愈追加进索引(D1)
        const target = bakTarget();
        renameSync(oldPath, target);
        this.audit("snapshots-migrated", { count: merged, renamedTo: basename(target) });
      } catch (error) {
        this.audit("snapshot-migration-failed", { error: String(error) });
      }
      return;
    }
    const tmpDir = join(this.dir, `snapshots.tmp-${process.pid}`);
    try {
      const dict = JSON.parse(readFileSync(oldPath, "utf8")) as Record<string, SourceSnapshot>;
      const order = Object.keys(dict);
      mkdirSync(tmpDir, { recursive: true });
      for (const id of order) {
        writeFileSync(join(tmpDir, snapshotFileName(id)), JSON.stringify(dict[id], null, 2));
      }
      writeFileSync(join(tmpDir, INDEX_FILE), JSON.stringify({ order }, null, 2));
      renameSync(tmpDir, newDir);
      renameSync(oldPath, bakPath);
      this.audit("snapshots-migrated", { count: order.length, renamedTo: "snapshots.json.bak" });
    } catch (error) {
      this.audit("snapshot-migration-failed", { error: String(error) });
      this.legacySnapshots = existsSync(oldPath);
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响回退
      }
    }
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


  /** P2-2:run 读取统一过 schema——存量 costEstimate 被 strip,新计量字段 default(0) 兜底。 */
  private readRun(rel: string): ResearchRun | null {
    const raw = this.readJson<Record<string, unknown> | null>(rel, null);
    if (!raw) return null;
    const parsed = ResearchRunSchema.safeParse(raw);
    return parsed.success ? parsed.data : (raw as unknown as ResearchRun);
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
    if (this.legacySnapshots) {
      const all = this.readJson<Record<string, SourceSnapshot>>("snapshots.json", {});
      all[snapshot.id] = snapshot;
      this.writeJson("snapshots.json", all);
      return;
    }
    // R1.2a:文件写入 + 索引读改写在同一同步块内完成,中间无 await(gather 并发原子性全靠同步块)
    mkdirSync(join(this.dir, "snapshots"), { recursive: true });
    const rel = join("snapshots", snapshotFileName(snapshot.id));
    const path = join(this.dir, rel);
    if (existsSync(path)) {
      // 同 id 覆盖写:只更新文件,不动索引位置(KA2 逐位语义);
      // 旧文件已损坏时读不出 id,按同 id 覆盖处理(垃圾内容本就该被覆盖)
      let existingId: string | undefined;
      try {
        existingId = (JSON.parse(readFileSync(path, "utf8")) as SourceSnapshot).id;
      } catch {
        existingId = snapshot.id;
      }
      if (existingId !== snapshot.id) {
        throw new Error(`快照文件名碰撞: ${snapshot.id} vs ${existingId}(R1.5 fail loud)`);
      }
      this.writeJson(rel, snapshot);
      return;
    }
    this.writeJson(rel, snapshot);
    const raw = readIndexRaw(join(this.dir, "snapshots"));
    const order = cleanOrder((raw as { order?: unknown } | null)?.order);
    order.push(snapshot.id);
    this.writeJson(join("snapshots", INDEX_FILE), { order });
  }

  /** P0-2 D3:单文件读,哈希→精确文件名,原始 id 永不拼路径(KA3)。 */
  async readSnapshot(id: string): Promise<SourceSnapshot | null> {
    if (this.legacySnapshots) {
      return this.readJson<Record<string, SourceSnapshot>>("snapshots.json", {})[id] ?? null;
    }
    const path = join(this.dir, "snapshots", snapshotFileName(id));
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as SourceSnapshot;
      return parsed.id === id ? parsed : null; // R1.5 碰撞校验:张冠李戴返回 null(端点 404)
    } catch {
      return null; // 坏文件按不存在处理(R1.4c)
    }
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

  /** 2.1:运行中干预指令的待消费队列落盘(服务重启/恢复后不丢)。 */
  async savePendingInstructions(runId: string, list: unknown[]): Promise<void> {
    mkdirSync(join(this.dir, "runs", runId), { recursive: true });
    this.writeJson(join("runs", runId, "pending-instructions.json"), list);
  }

  async readPendingInstructions(runId: string): Promise<unknown[]> {
    return this.readJson<unknown[]>(join("runs", runId, "pending-instructions.json"), []);
  }

  async findRunByRequestId(requestId: string): Promise<ResearchRun | undefined> {
    const runsDir = join(this.dir, "runs");
    if (!existsSync(runsDir)) return undefined;
    // 同一 requestId 可能存在多条记录(历史 resume/失败重发):按 run.json 修改时间取最新,
    // 恢复语义依赖拿到最近一次的记录,目录序会静默选中旧记录
    let best: { run: ResearchRun; mtimeMs: number } | undefined;
    for (const runId of readdirSync(runsDir)) {
      const rel = join("runs", runId, "run.json");
      const run = this.readRun(rel);
      if (run?.requestId !== requestId) continue;
      const mtimeMs = statSync(join(this.dir, rel)).mtimeMs;
      if (!best || mtimeMs >= best.mtimeMs) best = { run, mtimeMs };
    }
    return best?.run;
  }

  async readBundle(runId: string): Promise<ResearchResultBundle | null> {
    return this.readJson<ResearchResultBundle | null>(join("runs", runId, "bundle.json"), null);
  }

  async listSnapshots(): Promise<SourceSnapshot[]> {
    if (this.legacySnapshots) {
      return Object.values(this.readJson<Record<string, SourceSnapshot>>("snapshots.json", {}));
    }
    const newDir = join(this.dir, "snapshots");
    const { entries, corrupt } = scanSnapshotDir(newDir);
    for (const file of corrupt) this.audit("snapshot-file-corrupt", { file });
    const healed = healOrder(entries, readIndexRaw(newDir));
    if (healed.rebuilt) {
      // R1.4a:索引缺失/非法 → 重建并立即落盘 + audit
      mkdirSync(newDir, { recursive: true });
      this.writeJson(join("snapshots", INDEX_FILE), { order: healed.order });
      this.audit("snapshot-index-rebuilt", { count: healed.order.length });
    } else if (healed.changed) {
      // orphan 追加/缺失剔除:静默落盘(崩溃窗口自愈是常态路径)
      this.writeJson(join("snapshots", INDEX_FILE), { order: healed.order });
    }
    const byId = new Map(entries.map((e) => [e.id, e.snapshot]));
    return healed.order.map((id) => byId.get(id)!);
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
      const run = this.readRun(join("runs", runId, "run.json"));
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => a.id.localeCompare(b.id));
  }
}
