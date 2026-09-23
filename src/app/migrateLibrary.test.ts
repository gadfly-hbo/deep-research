import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsLibraryStore } from "../library/fsLibraryStore.js";
import { migrateProjectsToLibrary } from "./migrateLibrary.js";

const REAL_PROJECTS = join(process.cwd(), "research-data", "projects");

describe("历史项目登记级迁移(U2-09 / §13)", () => {
  let workDir: string;
  let projectsDir: string;
  let library: FsLibraryStore;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "dr-mig-"));
    projectsDir = join(workDir, "projects");
    // 只复制小样本项目,绝不动真实数据
    cpSync(join(REAL_PROJECTS, "p-muaqc9ys-q2xk1x"), join(projectsDir, "p-muaqc9ys-q2xk1x"), { recursive: true });
    cpSync(join(REAL_PROJECTS, "p-mual1oor-mc3x90"), join(projectsDir, "p-mual1oor-mc3x90"), { recursive: true });
    library = FsLibraryStore.openOrCreate(join(workDir, "library"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("dry-run 只出报告不写库:部分底稿与空壳分档", async () => {
    const report = await migrateProjectsToLibrary(projectsDir, library, { dryRun: true });
    const partial = report.projects.find((p) => p.projectId === "p-muaqc9ys-q2xk1x");
    const empty = report.projects.find((p) => p.projectId === "p-mual1oor-mc3x90");
    expect(partial?.tier).toBe("partial");
    expect(partial?.snapshotCount).toBe(6);
    expect(empty?.tier).toBe("empty");
    expect(await library.listSources()).toHaveLength(0);
  });

  it("apply 登记来源/版本/取得记录,默认项目范围且不搬文件", async () => {
    const report = await migrateProjectsToLibrary(projectsDir, library, { dryRun: false });
    expect(report.registeredSources).toBe(6);
    const sources = await library.listSources();
    // 同正文快照在存储层去重:来源数 ≤ 快照数,取得记录数 = 快照数(授权不合并)
    expect(sources.length).toBeLessThanOrEqual(6);
    const allAcqs = (
      await Promise.all(
        (await Promise.all(sources.map((s) => library.versionsForSource(s.sourceId)))).flat().map((v) =>
          library.acquisitionsForVersion(v.versionId),
        ),
      )
    ).flat();
    expect(allAcqs).toHaveLength(6);
    const source = sources[0];
    const versions = await library.versionsForSource(source.sourceId);
    expect(versions[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    const acqs = await library.acquisitionsForVersion(versions[0].versionId);
    expect(acqs[0].method).toBe("migration");
    expect(acqs[0].projectId).toBe("p-muaqc9ys-q2xk1x");
    expect(acqs[0].reuseScope).toBe("PROJECT_ONLY");
    // 原项目文件未被搬动
    expect(report.movedFiles).toBe(0);
  });

  it("只有报告的历史项目登记为派生成果,标底稿缺失(A-16)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(projectsDir, "p-reportonly");
    mkdirSync(join(dir, "reports", "v1"), { recursive: true });
    writeFileSync(join(dir, "project.json"), JSON.stringify({ id: "p-reportonly", module: "brand", goal: "g", scope: { summary: "s", queries: [] }, createdAt: "x", updatedAt: "x", versions: [{ version: 1, runId: "run-old", publishedAt: "x" }] }));
    writeFileSync(join(dir, "reports", "v1", "report.md"), "# 历史报告\n\n仅有结论,无底稿。");
    const report = await migrateProjectsToLibrary(projectsDir, library, { dryRun: false });
    const row = report.projects.find((p) => p.projectId === "p-reportonly");
    expect(row?.tier).toBe("report-only");
    const derived = (await library.listSources()).find((s) => s.docType === "research-report");
    expect(derived).toBeTruthy();
    expect(derived?.derivedFromRunId).toBe("run-old");
    // 派生成果在复用检查中只作线索,不充当已核验外部事实(A-10)
    const { checkReuse } = await import("../library/reuse.js");
    const versions = await library.versionsForSource(derived!.sourceId);
    const check = await checkReuse(library, {
      runId: "run-new",
      projectId: "p-other",
      sourceId: derived!.sourceId,
      versionId: versions[0].versionId,
      purpose: "x",
    });
    // 项目范围未授权 → 先 FORBIDDEN;授权后应为 LEAD_ONLY(派生)
    expect(["FORBIDDEN", "LEAD_ONLY"]).toContain(check.applicability);
  });

  it("重复执行幂等:映射表去重,不产生重复登记", async () => {
    await migrateProjectsToLibrary(projectsDir, library, { dryRun: false });
    const second = await migrateProjectsToLibrary(projectsDir, library, { dryRun: false });
    expect(second.registeredSources).toBe(0);
    expect((await library.listSources()).length).toBeLessThanOrEqual(6);
  });
});
