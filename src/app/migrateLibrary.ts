import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceSnapshot } from "../contracts.js";
import type { FsLibraryStore } from "../library/fsLibraryStore.js";

export interface ProjectMigrationRow {
  projectId: string;
  /** full=有运行成果包;partial=仅快照;report-only=仅有最终报告;empty=无底稿 */
  tier: "full" | "partial" | "report-only" | "empty";
  snapshotCount: number;
  evidenceCount: number;
  registered: number;
}

export interface MigrationReport {
  dryRun: boolean;
  projects: ProjectMigrationRow[];
  registeredSources: number;
  movedFiles: number;
}

const MAP_FILE = "migration-map.json";

interface MigrationMap {
  /** snapshotId -> versionId */
  snapshots: Record<string, string>;
}

function readMap(libraryDir: string): MigrationMap {
  const path = join(libraryDir, MAP_FILE);
  if (!existsSync(path)) return { snapshots: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MigrationMap;
  } catch {
    return { snapshots: {} };
  }
}

/**
 * 登记级迁移(§13.2/13.3):把历史项目的快照登记为情报库 Source/SourceVersion/AcquisitionRecord。
 * 只读旧数据、只写情报库;不搬文件、不改旧引用、不伪造核验记录。
 * 三档:完整底稿/仅快照/仅有报告(登记为派生成果并标底稿缺失,§13.2)。
 */
export async function migrateProjectsToLibrary(
  projectsDir: string,
  library: FsLibraryStore,
  opts: { dryRun: boolean },
): Promise<MigrationReport> {
  const map = readMap(library.dir);
  const report: MigrationReport = { dryRun: opts.dryRun, projects: [], registeredSources: 0, movedFiles: 0 };
  if (!existsSync(projectsDir)) return report;

  for (const projectId of readdirSync(projectsDir).sort()) {
    const dir = join(projectsDir, projectId);
    if (!existsSync(join(dir, "project.json"))) continue;
    const snapshotsPath = join(dir, "snapshots.json");
    const snapshots: Record<string, SourceSnapshot> = existsSync(snapshotsPath)
      ? (JSON.parse(readFileSync(snapshotsPath, "utf8")) as Record<string, SourceSnapshot>)
      : {};
    let evidenceCount = 0;
    let hasBundle = false;
    let latestReportRunId: string | null = null;
    let latestReportText: string | null = null;
    const runsDir = join(dir, "runs");
    if (existsSync(runsDir)) {
      for (const runId of readdirSync(runsDir)) {
        const bundlePath = join(runsDir, runId, "bundle.json");
        if (!existsSync(bundlePath)) continue;
        hasBundle = true;
        try {
          evidenceCount += (JSON.parse(readFileSync(bundlePath, "utf8")) as { evidence?: unknown[] }).evidence?.length ?? 0;
        } catch {
          /* 单个 bundle 损坏不影响迁移分档 */
        }
      }
    }
    // 只有报告的历史项目(§13.2 第三档):登记为派生成果,标底稿缺失,不伪造核验
    const reportsDir = join(dir, "reports");
    if (existsSync(reportsDir)) {
      const versionDirs = readdirSync(reportsDir)
        .filter((n) => /^v\d+$/.test(n))
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      const last = versionDirs[versionDirs.length - 1];
      const reportPath = last ? join(reportsDir, last, "report.md") : null;
      if (reportPath && existsSync(reportPath)) {
        latestReportText = readFileSync(reportPath, "utf8");
        const metaPath = join(dir, "project.json");
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { versions?: Array<{ runId: string; version: number }> };
          latestReportRunId = meta.versions?.find((v) => v.version === Number(last!.slice(1)))?.runId ?? null;
        } catch {
          latestReportRunId = null;
        }
      }
    }
    const snapshotCount = Object.keys(snapshots).length;
    const tier: ProjectMigrationRow["tier"] =
      snapshotCount === 0
        ? latestReportText !== null
          ? "report-only"
          : "empty"
        : hasBundle
          ? "full"
          : "partial";
    const row: ProjectMigrationRow = { projectId, tier, snapshotCount, evidenceCount, registered: 0 };

    if (tier === "report-only" && latestReportText !== null) {
      const mapKey = `report:${projectId}`;
      if (!map.snapshots[mapKey]) {
        if (!opts.dryRun) {
          const now = new Date().toISOString();
          const staging = await library.stageContent(latestReportText);
          const committed = await library.commitContent(staging);
          const sourceId = `s-hist-${projectId.slice(2, 8)}`;
          const versionId = `sv-${committed.contentHash.slice(0, 12)}`;
          await library.saveSource({
            sourceId,
            title: `历史研究成果(${projectId})`,
            docType: "research-report",
            derivedFromRunId: latestReportRunId ?? undefined,
            entityIds: [],
            tags: ["historical-derived"],
            lifecycle: "ACTIVE",
            createdAt: now,
          });
          await library.saveVersion({
            versionId,
            sourceId,
            contentRef: committed.contentRef,
            contentHash: committed.contentHash,
            fetchStatus: "READ_FULL",
            parseStatus: "ok",
            parseIssue: undefined,
            createdAt: now,
          });
          await library.saveAcquisition({
            acquisitionId: `aq-hist-${projectId.slice(2, 8)}`,
            versionId,
            projectId,
            acquiredAt: now,
            recordedAt: now,
            method: "migration",
            readScope: "READ_FULL",
            reuseScope: "PROJECT_ONLY",
            rights: {},
          });
          await library.saveReview({
            reviewId: `rr-hist-${projectId.slice(2, 8)}`,
            objectRef: sourceId,
            scope: projectId,
            checkType: "support",
            result: "issue",
            reason: "历史项目仅有最终报告:外部底稿未取得,不得拆成已核验外部事实(A-16)",
            reviewedAt: now,
            reviewer: "system:migration",
          });
          map.snapshots[mapKey] = versionId;
          row.registered += 1;
          report.registeredSources += 1;
        } else {
          row.registered += 1;
          report.registeredSources += 1;
        }
      }
      report.projects.push(row);
      continue;
    }

    for (const snapshot of Object.values(snapshots)) {
      if (map.snapshots[snapshot.id]) continue;
      const readable = snapshot.parseStatus === "ok" && snapshot.bodyText.trim() !== "";
      if (!opts.dryRun) {
        const now = new Date().toISOString();
        let versionId: string;
        let sourceId: string;
        if (readable) {
          const staging = await library.stageContent(snapshot.bodyText);
          const committed = await library.commitContent(staging);
          const existing = await library.findVersionByHash(committed.contentHash);
          if (existing) {
            versionId = existing.versionId;
            sourceId = existing.sourceId;
          } else {
            sourceId = `s-${snapshot.id.replace(/^snap:/, "").slice(0, 8)}-${Object.keys(map.snapshots).length}`;
            versionId = `sv-${committed.contentHash.slice(0, 12)}`;
            await library.saveSource({
              sourceId,
              title: snapshot.title || snapshot.url,
              url: snapshot.url,
              docType: "other",
              entityIds: [],
              tags: [],
              lifecycle: "ACTIVE",
              createdAt: now,
            });
            await library.saveVersion({
              versionId,
              sourceId,
              contentRef: committed.contentRef,
              contentHash: committed.contentHash,
              fetchStatus: "READ_FULL",
              parseStatus: "ok",
              createdAt: snapshot.fetchedAt,
            });
          }
        } else {
          sourceId = `s-${snapshot.id.replace(/^snap:/, "").slice(0, 8)}-${Object.keys(map.snapshots).length}`;
          versionId = `sv-mig-${snapshot.id.length.toString(16)}${Object.keys(map.snapshots).length}`;
          await library.saveSource({
            sourceId,
            title: snapshot.title || snapshot.url,
            url: snapshot.url,
            docType: "other",
            entityIds: [],
            tags: [],
            lifecycle: "ACTIVE",
            createdAt: now,
          });
          await library.saveVersion({
            versionId,
            sourceId,
            fetchStatus: "READ_PARTIAL",
            parseStatus: "failed",
            parseIssue: "迁移登记:历史快照解析失败,正文缺失(不伪造)",
            createdAt: snapshot.fetchedAt,
          });
        }
        await library.saveAcquisition({
          acquisitionId: `aq-mig-${projectId.slice(2, 8)}-${Object.keys(map.snapshots).length}`,
          versionId,
          projectId,
          acquiredAt: snapshot.fetchedAt,
          recordedAt: new Date().toISOString(),
          method: "migration",
          readScope: readable ? "READ_FULL" : "READ_PARTIAL",
          reuseScope: "PROJECT_ONLY",
          rights: {},
        });
        map.snapshots[snapshot.id] = versionId;
        row.registered += 1;
        report.registeredSources += 1;
      } else {
        row.registered += 1;
        report.registeredSources += 1;
      }
    }
    report.projects.push(row);
  }

  if (!opts.dryRun) {
    writeFileSync(join(library.dir, MAP_FILE), JSON.stringify(map, null, 2));
    library.audit("migration-applied", { projects: report.projects.length, registered: report.registeredSources });
  }
  return report;
}
