import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResearchResultBundle, ResearchRun, SourceSnapshot } from "../contracts.js";
import { FsProjectStore } from "./fsStore.js";

const tmp = () => mkdtempSync(join(tmpdir(), "dr-store-"));

const run: ResearchRun = {
  id: "run-1",
  requestId: "req-1",
  stage: "publish",
  status: "published",
  checkpoints: [],
  usage: { searches: 1, fetches: 1, modelCalls: 0, outputTokens: 0, wallMs: 10 },
};

const snapshot: SourceSnapshot = {
  id: "snap:https://a/1",
  url: "https://a/1",
  title: "A",
  fetchedAt: "2026-09-21T00:00:00.000Z",
  bodyText: "正文",
  parseStatus: "ok",
  contentType: "text/html",
};

const bundle: ResearchResultBundle = {
  runId: "run-1",
  version: 0,
  reportMd: "# 报告",
  claims: [
    { id: "c1", statement: "市场规模约 1200 亿元(2025)", kind: "fact", evidenceIds: ["e1"] },
  ],
  evidence: [{ id: "e1", snapshotId: "snap:https://a/1", quote: "1200 亿元" }],
  snapshots: [snapshot],
  limitations: [],
  unresolved: [],
  verdicts: [{ evidenceId: "e1", verdict: "quote-hit" }],
};

describe("FsProjectStore", () => {
  it("保存 run/快照/检查点/成果包后,新实例重开全部可读回(模拟进程重启)", async () => {
    const dir = tmp();
    const store = FsProjectStore.create(dir, {
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "中国大陆 2025", queries: [] },
    });
    await store.saveRun(run);
    await store.saveSnapshot(snapshot);
    await store.saveCheckpoint({ runId: "run-1", stage: "gather", data: { ok: true }, completedAt: "2026-09-21T00:00:00.000Z" });
    await store.saveBundle(bundle);

    const reopened = FsProjectStore.open(dir);
    expect(await reopened.findRunByRequestId("req-1")).toEqual(run);
    expect(await reopened.checkpoints("run-1")).toHaveLength(1);
    expect(await reopened.readBundle("run-1")).toEqual(bundle);
    expect((await reopened.listSnapshots())[0]).toEqual(snapshot);
    expect(reopened.meta().goal).toBe("中国咖啡行业研究");
  });

  it("审计日志 append-only:逐行可解析且按序累积", async () => {
    const dir = tmp();
    const store = FsProjectStore.create(dir, {
      module: "brand",
      goal: "g",
      scope: { summary: "s", queries: [] },
    });
    await store.saveRun(run);
    await store.saveBundle(bundle);
    const lines = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events[0]).toBe("project-created");
    expect(events).toContain("run-finished");
    expect(events).toContain("bundle-saved");
  });

  it("未知 requestId 返回 undefined", async () => {
    const dir = tmp();
    FsProjectStore.create(dir, { module: "brand", goal: "g", scope: { summary: "s", queries: [] } });
    const reopened = FsProjectStore.open(dir);
    expect(await reopened.findRunByRequestId("nope")).toBeUndefined();
  });

  it("P2-4:调查事件 append/read 增量,seq 跨实例续写单调(模拟进程重启/resume)", async () => {
    const dir = tmp();
    const store = FsProjectStore.create(dir, { module: "brand", goal: "g", scope: { summary: "s", queries: [] } });
    const e1 = await store.appendInvestigation("run-1", { qid: "q1", kind: "query", summary: "市场规模", query: "市场规模" });
    const e2 = await store.appendInvestigation("run-1", { qid: "q1", kind: "fetch", summary: "https://a/1", url: "https://a/1" });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.at).toBeTruthy();

    // 新实例续写:seq 接尾行 +1,不回卷(跨 resume 单调)
    const reopened = FsProjectStore.open(dir);
    const e3 = await reopened.appendInvestigation("run-1", { qid: "q1", kind: "verdict", summary: "充分", sufficient: true });
    expect(e3.seq).toBe(3);

    const all = await reopened.readInvestigation("run-1");
    expect(all.map((e) => `${e.seq}:${e.kind}`)).toEqual(["1:query", "2:fetch", "3:verdict"]);
    // 增量读回:since 游标 + limit 截断
    expect((await reopened.readInvestigation("run-1", 1)).map((e) => e.seq)).toEqual([2, 3]);
    expect((await reopened.readInvestigation("run-1", 0, 2)).map((e) => e.seq)).toEqual([1, 2]);
    // 其他 run/不存在:空
    expect(await reopened.readInvestigation("run-other")).toEqual([]);
  });

  it("同一 requestId 多条 run 记录时按 mtime 取最新(恢复不误选旧记录)", async () => {
    const dir = tmp();
    const store = FsProjectStore.create(dir, { module: "brand", goal: "g", scope: { summary: "s", queries: [] } });
    await store.saveRun({ ...run, id: "a-run" });
    await new Promise((r) => setTimeout(r, 10));
    await store.saveRun({ ...run, id: "b-run", status: "cancelled" });
    const found = await FsProjectStore.open(dir).findRunByRequestId("req-1");
    expect(found?.id).toBe("b-run");
  });
});

// ---- P0-2 快照布局(T2)----
const snap = (id: string, fetchedAt: string, body = `正文-${id}`): SourceSnapshot => ({
  id,
  url: `https://a/${id}`,
  title: id,
  fetchedAt,
  bodyText: body,
  parseStatus: "ok",
  contentType: "text/html",
});

const mk = () => {
  const dir = tmp();
  const store = FsProjectStore.create(dir, { module: "brand", goal: "g", scope: { summary: "s", queries: [] } });
  return { dir, store };
};

describe("FsProjectStore 快照一文件一快照(P0-2)", () => {
  it("KA2:乱序写入 + 同 id 覆盖后,listSnapshots 顺序与旧字典语义逐位一致", async () => {
    const { store } = mk();
    await store.saveSnapshot(snap("snap:c", "2026-01-03T00:00:00.000Z"));
    await store.saveSnapshot(snap("snap:a", "2026-01-01T00:00:00.000Z"));
    await store.saveSnapshot(snap("snap:b", "2026-01-02T00:00:00.000Z"));
    // 覆盖写 snap:a(新 fetchedAt):内容更新、位置不变
    await store.saveSnapshot(snap("snap:a", "2026-06-01T00:00:00.000Z", "更新后正文"));
    const list = await store.listSnapshots();
    expect(list.map((s) => s.id)).toEqual(["snap:c", "snap:a", "snap:b"]);
    expect(list[1].bodyText).toBe("更新后正文");
  });

  it("readSnapshot:命中返回本体,未知 id 与路径穿越串一律 null", async () => {
    const { store } = mk();
    await store.saveSnapshot(snap("snap:https://a/1", "2026-01-01T00:00:00.000Z"));
    expect((await store.readSnapshot("snap:https://a/1"))?.bodyText).toBe("正文-snap:https://a/1");
    expect(await store.readSnapshot("snap:nope")).toBeNull();
    expect(await store.readSnapshot("../../project.json")).toBeNull();
    expect(await store.readSnapshot("snap%3A..%2F..")).toBeNull();
  });

  it("迁移:旧 snapshots.json open 即迁,数据原样保序可读,旧文件改名 .bak,二次 open 幂等", async () => {
    const dir = tmp();
    const store = FsProjectStore.create(dir, { module: "brand", goal: "g", scope: { summary: "s", queries: [] } });
    // 退回旧格式:删新目录,手写 snapshots.json(乱序键,验证保序)
    rmSync(join(dir, "snapshots"), { recursive: true });
    const legacy = { "snap:z": snap("snap:z", "2026-01-03T00:00:00.000Z"), "snap:a": snap("snap:a", "2026-01-01T00:00:00.000Z") };
    writeFileSync(join(dir, "snapshots.json"), JSON.stringify(legacy, null, 2));

    const opened = FsProjectStore.open(dir);
    expect((await opened.listSnapshots()).map((s) => s.id)).toEqual(["snap:z", "snap:a"]);
    expect(existsSync(join(dir, "snapshots.json"))).toBe(false);
    expect(existsSync(join(dir, "snapshots.json.bak"))).toBe(true);
    expect((await opened.readSnapshot("snap:a"))?.url).toBe("https://a/snap:a");
    // 幂等:再次 open 不再迁移、审计只有一条 snapshots-migrated
    FsProjectStore.open(dir);
    const audits = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
    expect(audits.filter((e) => e === "snapshots-migrated")).toHaveLength(1);
  });

  it("迁移失败回退:损坏的 snapshots.json 不炸 open,旧文件原地保留并 audit", async () => {
    const dir = tmp();
    FsProjectStore.create(dir, { module: "brand", goal: "g", scope: { summary: "s", queries: [] } });
    rmSync(join(dir, "snapshots"), { recursive: true });
    writeFileSync(join(dir, "snapshots.json"), "{损坏");

    const opened = FsProjectStore.open(dir); // 不抛错,不拖垮项目列表
    expect(existsSync(join(dir, "snapshots.json"))).toBe(true); // 旧文件不动
    expect(existsSync(join(dir, "snapshots"))).toBe(false);
    // 回退旧格式后读写损坏文件的行为与现状一致(抛错,不静默归零);迁移失败已留痕
    await expect(opened.listSnapshots()).rejects.toThrow();
    const audits = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
    expect(audits).toContain("snapshot-migration-failed");
  });

  it("自愈:索引缺失按 fetchedAt 重建落盘并 audit;orphan 追加;坏文件跳过并 audit", async () => {
    const { dir, store } = mk();
    await store.saveSnapshot(snap("snap:b", "2026-01-02T00:00:00.000Z"));
    await store.saveSnapshot(snap("snap:a", "2026-01-01T00:00:00.000Z"));
    rmSync(join(dir, "snapshots", "index.json"));
    // 坏文件 + 杂物
    writeFileSync(join(dir, "snapshots", "deadbeefdeadbeef.json"), "{坏");
    writeFileSync(join(dir, "snapshots", ".DS_Store"), "x");

    const reopened = FsProjectStore.open(dir);
    const list = await reopened.listSnapshots();
    expect(list.map((s) => s.id)).toEqual(["snap:a", "snap:b"]); // fetchedAt 升序重建
    expect(existsSync(join(dir, "snapshots", "index.json"))).toBe(true); // 立即落盘
    const audits = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
    expect(audits).toContain("snapshot-index-rebuilt");
    expect(audits).toContain("snapshot-file-corrupt");
  });

  it("崩溃窗口:文件已写但索引未写,listSnapshots 自愈追加到末尾", async () => {
    const { dir, store } = mk();
    await store.saveSnapshot(snap("snap:a", "2026-01-01T00:00:00.000Z"));
    // 模拟崩溃:直接写文件不进索引
    const orphan = snap("snap:orphan", "2026-01-02T00:00:00.000Z");
    const { createHash } = await import("node:crypto");
    const fn = createHash("sha256").update(orphan.id).digest("hex").slice(0, 16) + ".json";
    writeFileSync(join(dir, "snapshots", fn), JSON.stringify(orphan, null, 2));

    const reopened = FsProjectStore.open(dir);
    expect((await reopened.listSnapshots()).map((s) => s.id)).toEqual(["snap:a", "snap:orphan"]);
    // 自愈已把 orphan 持久化进索引
    const idx = JSON.parse(readFileSync(join(dir, "snapshots", "index.json"), "utf8"));
    expect(idx.order).toEqual(["snap:a", "snap:orphan"]);
  });

  it("R1.5 碰撞:目标文件内 id 不符时 saveSnapshot 抛错(fail loud)", async () => {
    const { dir, store } = mk();
    const victim = snap("snap:victim", "2026-01-01T00:00:00.000Z");
    await store.saveSnapshot(victim);
    // 伪造碰撞:把 victim 的文件内容换成别的 id(文件名不变)
    const { createHash } = await import("node:crypto");
    const fn = createHash("sha256").update(victim.id).digest("hex").slice(0, 16) + ".json";
    writeFileSync(join(dir, "snapshots", fn), JSON.stringify(snap("snap:intruder", "2026-01-01T00:00:00.000Z")));
    await expect(store.saveSnapshot(snap("snap:victim", "2026-02-01T00:00:00.000Z"))).rejects.toThrow("碰撞");
  });
});
