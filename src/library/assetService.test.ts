import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAsset, registerAssets, assertPublicUrl, fetchAssetContent } from "./assetService.js";
import { FsLibraryStore } from "./fsLibraryStore.js";

describe("registerAsset 直接入库", () => {
  let dir: string;
  let store: FsLibraryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lib-svc-"));
    store = FsLibraryStore.openOrCreate(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("导入 Markdown 文件:创建来源/版本/取得记录,内容入内容寻址存储,默认 PROJECT_ONLY", async () => {
    const out = await registerAsset(store, {
      kind: "file",
      filename: "安克品牌笔记.md",
      content: "# 安克\n中国市场笔记正文",
    });
    expect(out.status).toBe("registered");
    const source = await store.getSource(out.sourceId);
    expect(source?.title).toBe("安克品牌笔记");
    expect(source?.docType).toBe("other");
    const version = await store.getVersion(out.versionId);
    expect(version?.fetchStatus).toBe("READ_FULL");
    expect(version?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.readContent(version!.contentRef!)).toContain("中国市场笔记正文");
    const acq = await store.getAcquisition(out.acquisitionId);
    expect(acq?.reuseScope).toBe("PROJECT_ONLY");
    expect(acq?.method).toBe("user-file");
  });

  it("声明的元数据被采纳,未声明的保持未知(不虚构)", async () => {
    const out = await registerAsset(store, {
      kind: "file",
      filename: "report.pdf.txt",
      content: "正文",
      title: "2025 年度报告",
      publisher: "某集团",
      docType: "financial-disclosure",
      dataPeriod: "2025FY",
    });
    const source = await store.getSource(out.sourceId);
    expect(source?.publisher).toBe("某集团");
    expect(source?.docType).toBe("financial-disclosure");
    const version = await store.getVersion(out.versionId);
    expect(version?.dataPeriod).toBe("2025FY");
    expect(version?.publishedAt).toBeUndefined();
  });

  it("精确重复:相同内容再次导入识别为 duplicate,不产生新记录", async () => {
    const first = await registerAsset(store, { kind: "file", filename: "a.md", content: "相同正文" });
    const second = await registerAsset(store, { kind: "file", filename: "b.md", content: "相同正文" });
    expect(second.status).toBe("duplicate");
    expect(second.versionId).toBe(first.versionId);
    expect(await store.listSources()).toHaveLength(1);
    expect(await store.acquisitionsForVersion(first.versionId)).toHaveLength(1);
  });

  it("幂等键重试:网络重试重复提交返回原登记,不重复创建", async () => {
    const first = await registerAsset(store, {
      kind: "file",
      filename: "a.md",
      content: "正文",
      idempotencyKey: "batch-2026-09-23-item-1",
    });
    const retry = await registerAsset(store, {
      kind: "file",
      filename: "a.md",
      content: "正文",
      idempotencyKey: "batch-2026-09-23-item-1",
    });
    expect(retry.status).toBe("duplicate");
    expect(retry.acquisitionId).toBe(first.acquisitionId);
  });

  it("链接登记:只登记入口,状态 DISCOVERED,无内容引用,不冒充已读正文", async () => {
    const out = await registerAsset(store, {
      kind: "link",
      url: "https://example.com/report/2025",
      title: "某行业报告页",
    });
    expect(out.status).toBe("registered");
    const version = await store.getVersion(out.versionId);
    expect(version?.fetchStatus).toBe("DISCOVERED");
    expect(version?.contentRef).toBeUndefined();
    const acq = await store.getAcquisition(out.acquisitionId);
    expect(acq?.readScope).toBe("DISCOVERED");
    expect(acq?.method).toBe("user-link");
  });

  it("超大文件被拒绝(上限 50MB,WP02 冻结参数)", async () => {
    const big = "x".repeat(50 * 1024 * 1024 + 1);
    await expect(registerAsset(store, { kind: "file", filename: "big.txt", content: big })).rejects.toThrow(
      /50MB/,
    );
    expect(await store.listSources()).toHaveLength(0);
  });
});

describe("assertPublicUrl SSRF 边界(S-06)", () => {
  it("拒绝本机与私网地址(含整型/十六进制写法)", () => {
    for (const url of [
      "http://127.0.0.1:8080/admin",
      "http://localhost/x",
      "http://10.0.0.5/internal",
      "http://192.168.1.10/router",
      "http://172.16.0.3/svc",
      "http://169.254.169.254/latest/meta-data",
      "http://2130706433/x",
      "http://0x7f000001/x",
      "http://[::1]/x",
      "http://[::ffff:127.0.0.1]/x",
      "http://[::ffff:7f00:1]/x",
      "http://[fd00::1]/x",
      "http://[fe80::1]/x",
      "file:///etc/passwd",
      "ftp://example.com/x",
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow();
    }
  });

  it("放行公开 http/https(含公开 IPv6)", () => {
    expect(() => assertPublicUrl("https://example.com/a")).not.toThrow();
    expect(() => assertPublicUrl("http://www.gov.cn/b")).not.toThrow();
    expect(() => assertPublicUrl("http://[2606:4700::1]/c")).not.toThrow();
  });
});

describe("fetchAssetContent 链接正文取得(取得与解析分开记录)", () => {
  let dir: string;
  let store: FsLibraryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lib-fetch-"));
    store = FsLibraryStore.openOrCreate(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("取得成功:产生新版本(READ_FULL + 内容),原 DISCOVERED 版本保留,取得记录可解释", async () => {
    const reg = await registerAsset(store, { kind: "link", url: "https://example.com/r", title: "报告页" });
    const out = await fetchAssetContent(store, reg.versionId, {
      page: {
        async fetch() {
          return { url: "https://example.com/r", status: 200, contentType: "text/html", html: "<p>正文内容</p>" };
        },
      },
      parser: { async parse() { return { bodyText: "正文内容", parseStatus: "ok" as const }; } },
    });
    expect(out.fetchStatus).toBe("READ_FULL");
    expect(out.versionId).not.toBe(reg.versionId);
    const newVersion = await store.getVersion(out.versionId);
    expect(await store.readContent(newVersion!.contentRef!)).toContain("正文内容");
    // 历史不改写:原登记版本仍是 DISCOVERED
    expect((await store.getVersion(reg.versionId))?.fetchStatus).toBe("DISCOVERED");
    expect((await store.versionsForSource(reg.sourceId)).length).toBe(2);
    const acqs = await store.acquisitionsForVersion(out.versionId);
    expect(acqs[0].readScope).toBe("READ_FULL");
  });

  it("取得失败:版本 UNAVAILABLE 且原因可见,不假装成功", async () => {
    const reg = await registerAsset(store, { kind: "link", url: "https://example.com/dead", title: "死链" });
    const out = await fetchAssetContent(store, reg.versionId, {
      page: {
        async fetch() {
          return { url: "https://example.com/dead", status: 404, contentType: "", error: "404" };
        },
      },
      parser: { async parse() { return { bodyText: "", parseStatus: "failed" as const }; } },
    });
    expect(out.fetchStatus).toBe("UNAVAILABLE");
    const v = await store.getVersion(out.versionId);
    expect(v?.parseStatus).toBe("failed");
    expect(v?.parseIssue).toBeTruthy();
  });

  it("取得目标仍查 SSRF:登记后篡改的私网 URL 不发起取得", async () => {
    const reg = await registerAsset(store, { kind: "link", url: "https://example.com/ok" });
    await expect(
      fetchAssetContent(store, reg.versionId, {
        page: { async fetch() { throw new Error("不应被调用"); } },
        parser: { async parse() { return { bodyText: "", parseStatus: "failed" as const }; } },
        urlOverride: "http://127.0.0.1/internal",
      }),
    ).rejects.toThrow(/私网|本机/);
  });
});

describe("PDF 文件导入(解析缺口可见,A-04)", () => {
  let dir: string;
  let store: FsLibraryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lib-pdf-"));
    store = FsLibraryStore.openOrCreate(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("文本 PDF 解析成功:正文入库,parseStatus ok", async () => {
    const out = await registerAsset(
      store,
      { kind: "file", filename: "财报.pdf", content: new Uint8Array([37, 80, 68, 70]) },
      { parsePdf: async () => ({ bodyText: "营业收入 100 亿元", parseStatus: "ok" as const }) },
    );
    expect(out.parseStatus).toBe("ok");
    const v = await store.getVersion(out.versionId);
    expect(await store.readContent(v!.contentRef!)).toContain("100 亿元");
  });

  it("PDF 解析失败:资产仍登记,parseStatus=failed + 原因可见,正文缺失如实呈现", async () => {
    const out = await registerAsset(
      store,
      { kind: "file", filename: "扫描件.pdf", content: new Uint8Array([37, 80, 68, 70]) },
      { parsePdf: async () => ({ bodyText: "", parseStatus: "failed" as const }) },
    );
    expect(out.status).toBe("registered");
    expect(out.parseStatus).toBe("failed");
    const v = await store.getVersion(out.versionId);
    expect(v?.parseIssue).toBeTruthy();
    expect(v?.fetchStatus).toBe("READ_PARTIAL");
  });
});

describe("registerAssets 批量入库", () => {
  let dir: string;
  let store: FsLibraryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lib-batch-"));
    store = FsLibraryStore.openOrCreate(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("逐项状态:成功/重复/失败分别可见,不用一个全部完成掩盖", async () => {
    const results = await registerAssets(store, [
      { kind: "file", filename: "a.md", content: "正文A" },
      { kind: "file", filename: "b.md", content: "正文A" },
      { kind: "file", filename: "c.bin", content: new Uint8Array([1, 2]) },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("registered");
    expect(results[1].status).toBe("duplicate");
    expect(results[2].status).toBe("failed");
    expect(results[2].error).toBeTruthy();
  });

  it("批量上限:超过 20 项的条目按失败回报,不静默截断", async () => {
    const many = Array.from({ length: 23 }, (_, i) => ({
      kind: "file" as const,
      filename: `f${i}.md`,
      content: `正文${i}`,
    }));
    const results = await registerAssets(store, many);
    expect(results).toHaveLength(23);
    expect(results.filter((r) => r.status === "failed").some((r) => r.error?.includes("上限"))).toBe(true);
    expect(results.slice(0, 20).every((r) => r.status !== "failed" || !r.error?.includes("上限"))).toBe(true);
  });
});

describe("跨项目内容去重不合并授权(§8.1/S-02)", () => {
  let dir: string;
  let store: FsLibraryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lib-dedup-"));
    store = FsLibraryStore.openOrCreate(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("相同内容被两个项目导入:复用同一版本,但各自持有独立取得记录与权利", async () => {
    const a = await registerAsset(store, {
      kind: "file",
      filename: "shared.md",
      content: "同一份公开披露正文",
      projectId: "p-a",
      rights: { exportFulltext: false },
    });
    const b = await registerAsset(store, {
      kind: "file",
      filename: "shared-copy.md",
      content: "同一份公开披露正文",
      projectId: "p-b",
      rights: { exportFulltext: true },
    });
    expect(b.status).toBe("duplicate");
    expect(b.versionId).toBe(a.versionId);
    expect(b.acquisitionId).not.toBe(a.acquisitionId);
    const acqs = await store.acquisitionsForVersion(a.versionId);
    expect(acqs).toHaveLength(2);
    expect(acqs.find((x) => x.acquisitionId === a.acquisitionId)?.rights.exportFulltext).toBe(false);
    expect(acqs.find((x) => x.acquisitionId === b.acquisitionId)?.rights.exportFulltext).toBe(true);
  });
});

describe("链接取得继承登记上下文并重定向复查(S-06)", () => {
  let dir: string;
  let store: FsLibraryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lib-fetchctx-"));
    store = FsLibraryStore.openOrCreate(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("重定向到私网的最终地址被拒", async () => {
    const reg = await registerAsset(store, { kind: "link", url: "https://example.com/ok", projectId: "p-x" });
    await expect(
      fetchAssetContent(store, reg.versionId, {
        page: {
          async fetch() {
            return { url: "https://example.com/ok", finalUrl: "http://10.1.2.3/internal", status: 200, contentType: "text/html", html: "<p>x</p>" };
          },
        },
        parser: { async parse() { return { bodyText: "x", parseStatus: "ok" as const }; } },
      }),
    ).rejects.toThrow(/私网/);
  });

  it("取得记录继承登记的项目与权利", async () => {
    const reg = await registerAsset(store, {
      kind: "link",
      url: "https://example.com/r",
      projectId: "p-x",
      rights: { sendToExternalModel: true },
    });
    const out = await fetchAssetContent(store, reg.versionId, {
      page: { async fetch(url) { return { url, status: 200, contentType: "text/html", html: "<p>正文</p>" }; } },
      parser: { async parse() { return { bodyText: "正文", parseStatus: "ok" as const }; } },
    });
    const acqs = await store.acquisitionsForVersion(out.versionId);
    expect(acqs[0].projectId).toBe("p-x");
    expect(acqs[0].rights.sendToExternalModel).toBe(true);
  });
});
