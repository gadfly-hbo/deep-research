import { mkdtempSync, readFileSync } from "node:fs";
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
  usage: { searches: 1, fetches: 1, costEstimate: 0.01, wallMs: 10 },
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
});
