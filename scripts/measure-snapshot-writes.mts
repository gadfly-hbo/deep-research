// P0-2 写侧量化:replay 金样本夹具跑完整 runResearch,store 用临时目录 FsProjectStore,
// 统计快照相关写盘字节数 vs 总写字节数(改造前后各跑一次同一 fixture 对比)。
// 用法:npx tsx scripts/measure-snapshot-writes.mts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayAdapters } from "../src/adapters/replay.js";
import { ResearchRequestSchema } from "../src/contracts.js";
import { runResearch, type RunOptions } from "../src/core/runResearch.js";
import { FsProjectStore } from "../src/stores/fsStore.js";

const GOLDEN = new URL("../testdata/golden/", import.meta.url).pathname;

const FIXTURES: Array<{ name: string; runId: string; requestId: string; options?: Partial<RunOptions> }> = [
  { name: "g1-clean-pipeline", runId: "run-golden-1", requestId: "req-golden-1" },
  {
    name: "g2-repair-loop",
    runId: "run-golden-2",
    requestId: "req-golden-2",
    options: {
      plan: {
        questions: [
          { id: "q1", question: "咖啡市场规模", status: "open" },
          { id: "q2", question: "门店数量", status: "open" },
        ],
      },
    },
  },
  {
    name: "g3-intervention",
    runId: "run-golden-3",
    requestId: "req-golden-3",
    options: {
      plan: { questions: [{ id: "q1", question: "咖啡市场规模", status: "open" }] },
      pollInstructions: (() => {
        const batches = [
          [
            { id: "ins-a", submittedAt: "2026-10-14T00:00:00.000Z", instruction: { type: "add-source" as const, text: "补充材料:门店结构持续优化" } },
            { id: "ins-b", submittedAt: "2026-10-14T00:00:00.000Z", instruction: { type: "add-questions" as const, questions: ["门店结构"] } },
          ],
        ];
        return () => batches.shift() ?? [];
      })(),
    },
  },
];

for (const fx of FIXTURES) {
  const golden = JSON.parse(readFileSync(join(GOLDEN, `${fx.name}.json`), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "dr-measure-"));
  const store = FsProjectStore.create(dir, {
    module: "industry",
    goal: "量化测量",
    scope: { summary: "s", queries: ["q"] },
  });
  let snapshotBytes = 0;
  let totalBytes = 0;
  const orig = (store as unknown as { writeJson: (rel: string, v: unknown) => void }).writeJson.bind(store);
  (store as unknown as { writeJson: (rel: string, v: unknown) => void }).writeJson = (rel, v) => {
    const bytes = Buffer.byteLength(JSON.stringify(v, null, 2));
    totalBytes += bytes;
    if (rel.startsWith("snapshots")) snapshotBytes += bytes;
    orig(rel, v);
  };
  const request = ResearchRequestSchema.parse({
    id: fx.requestId,
    module: "industry",
    goal: "量化测量",
    scope: { summary: "s", queries: ["q"] },
  });
  const options: RunOptions = { runId: fx.runId, ...fx.options };
  await runResearch(request, replayAdapters(golden.calls), store, options);
  console.log(
    JSON.stringify({ fixture: fx.name, snapshotBytes, totalBytes, ratio: +(snapshotBytes / totalBytes).toFixed(3) }),
  );
  rmSync(dir, { recursive: true, force: true });
}
