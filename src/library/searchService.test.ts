import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAsset } from "./assetService.js";
import { FsLibraryStore } from "./fsLibraryStore.js";
import { rebuildIndex, searchAssets } from "./searchService.js";

/** 冻结夹具:两类品牌文档 + 一类行业文档,中文/英文别名/数字口径各一条 */
async function seed(store: FsLibraryStore): Promise<{ anker: string; coffee: string; semir: string }> {
  const anker = await registerAsset(store, {
    kind: "file",
    filename: "安克品牌笔记.md",
    content: "安克(Anker)在中国市场的品牌定位:充电器与储能品类份额领先,渠道以线上为主。",
    reuseScope: "WORKSPACE_REUSABLE",
  });
  const coffee = await registerAsset(store, {
    kind: "file",
    filename: "咖啡行业.md",
    content: "中国咖啡零售行业规模约 1200 亿元,含现磨与即饮,边界不含茶叶。",
    docType: "industry-report",
  });
  const semir = await registerAsset(store, {
    kind: "file",
    filename: "森马年报摘录.md",
    content: "森马服饰 2024 年年报:营收 150 亿元,童装占比过半。",
    docType: "financial-disclosure",
    projectId: "p-senma",
  });
  return { anker: anker.sourceId, coffee: coffee.sourceId, semir: semir.sourceId };
}

describe("searchAssets 授权检索", () => {
  let dir: string;
  let store: FsLibraryStore;
  let ids: { anker: string; coffee: string; semir: string };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lib-search-"));
    store = FsLibraryStore.openOrCreate(dir);
    ids = await seed(store);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("工作台视图:中文正文/英文别名/数字口径均可召回(冻结夹具)", async () => {
    const cn = await searchAssets(store, "咖啡", {}, {});
    expect(cn.results.map((r) => r.sourceId)).toEqual([ids.coffee]);
    expect(cn.results[0].snippet).toContain("咖啡");

    const en = await searchAssets(store, "Anker", {}, {});
    expect(en.results.map((r) => r.sourceId)).toEqual([ids.anker]);

    const num = await searchAssets(store, "1200", {}, {});
    expect(num.results.map((r) => r.sourceId)).toEqual([ids.coffee]);
  });

  it("S-01:项目上下文搜索不泄露其他项目的 PROJECT_ONLY 资产", async () => {
    const out = await searchAssets(store, "森马", {}, { projectId: "p-other" });
    expect(out.results).toEqual([]);
    // 本项目自己的资产可搜到
    const own = await searchAssets(store, "森马", {}, { projectId: "p-senma" });
    expect(own.results.map((r) => r.sourceId)).toEqual([ids.semir]);
  });

  it("WORKSPACE_REUSABLE 资产可被其他项目检索到", async () => {
    const out = await searchAssets(store, "安克", {}, { projectId: "p-other" });
    expect(out.results.map((r) => r.sourceId)).toEqual([ids.anker]);
  });

  it("筛选:docType + 取得状态过滤生效", async () => {
    const byType = await searchAssets(store, "150", { docType: "financial-disclosure" }, {});
    expect(byType.results.map((r) => r.sourceId)).toEqual([ids.semir]);
    const wrongType = await searchAssets(store, "150", { docType: "industry-report" }, {});
    expect(wrongType.results).toEqual([]);
    const byStatus = await searchAssets(store, "森马", { fetchStatus: "READ_FULL" }, {});
    expect(byStatus.results).toHaveLength(1);
    const none = await searchAssets(store, "森马", { fetchStatus: "DISCOVERED" }, {});
    expect(none.results).toEqual([]);
  });

  it("索引缺失时可重建且不视为原文丢失(S-12/A-17)", async () => {
    rmSync(join(dir, "index.json"), { force: true });
    const out = await searchAssets(store, "咖啡", {}, {});
    expect(out.indexState).toBe("rebuilt");
    expect(out.results.map((r) => r.sourceId)).toEqual([ids.coffee]);
    // 显式重建同样幂等
    await rebuildIndex(store);
    const again = await searchAssets(store, "咖啡", {}, {});
    expect(again.indexState).toBe("ok");
  });

  it("索引落后于新入库资产时自动重建,全词命中的排首位", async () => {
    await searchAssets(store, "咖啡", {}, {}); // 建索引
    await registerAsset(store, { kind: "file", filename: "新品牌.md", content: "某新品牌充电宝评测" });
    const out = await searchAssets(store, "充电宝", {}, {});
    expect(out.indexState).toBe("rebuilt");
    expect(out.results[0].sourceId).toBeTruthy();
    expect(out.results[0].title).toBe("新品牌");
    expect(out.results[0].matchedTerms).toEqual(["充电", "电宝"]);
  });

  it("空查询返回空结果(浏览走列表路由,检索必须有查询)", async () => {
    const out = await searchAssets(store, "", {}, {});
    expect(out.results).toEqual([]);
  });

  it("更正版本对有权项目可见且索引自动重建(A-13/§12.3)", async () => {
    const { correctVersion } = await import("./lifecycle.js");
    const before = await searchAssets(store, "更正后", {}, {});
    expect(before.results).toEqual([]);
    await correctVersion(store, ids.coffee, (await store.versionsForSource(ids.coffee))[0].versionId, "更正后正文:口径修订说明。");
    const after = await searchAssets(store, "更正后", {}, {});
    expect(after.results.map((r) => r.sourceId)).toEqual([ids.coffee]);
    expect(after.indexState).toBe("rebuilt");
  });
});
