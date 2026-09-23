/* 单项目详情上下文:2.5s 轮询,三栏(侧栏运行/中央区/Inspector)共享一份数据。
   集中承载运行操作(启动/取消/恢复/发布)、版本 bundle 选择、正式报告探测、主张选中与快照文本缓存。 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, errMsg, post } from "./api";
import { useToast } from "./toast";
import { useUI } from "./ui";
import { useProjects } from "./projects";
import { STAGES } from "./types";
import type { Bundle, Claim, Outline, ProjectDetail, Run } from "./types";

export interface SelectedAsset {
  sourceId: string;
  versionId: string;
  purpose: string;
  applicability?: string;
  asOf?: string;
}

export interface StartRunParams {
  goal: string;
  summary: string;
  attachments: string;
  plan: { id: string; question: string }[];
  outline: Outline;
  /** 2.0:启动前选择的已有情报;服务端检查权限并固定版本绑定 */
  selectedAssets?: SelectedAsset[];
}

interface ProjectCtx {
  id: string;
  detail: ProjectDetail | null;
  loadFailed: boolean;
  activeRun: Run | null;
  /** 运行进度标记:0-6,用于 stagebar done/locked 判定 */
  progress: number;
  bundle: Bundle | null;
  bundleVersion: number | null;
  selectVersion(v: number): Promise<void>;
  formalReady: Record<number, boolean>;
  genFormal(v: number): Promise<void>;
  busy: string;
  startRun(p: StartRunParams): Promise<{ ok: boolean; rejected: Array<{ sourceId: string; reason: string }> }>;
  cancelRun(r: Run): Promise<void>;
  resumeRun(r: Run): Promise<void>;
  publishRun(r: Run): Promise<void>;
  selectedClaim: Claim | null;
  snapshotText: string | null;
  openClaim(c: Claim | null): void;
  reload(): Promise<void>;
}

const Ctx = createContext<ProjectCtx | null>(null);

const stageIndexOf = (stage: string): number => Math.max(0, STAGES.findIndex((s) => s.key === stage));

export function ProjectDetailProvider({ id, children }: { id: string; children: ReactNode }) {
  const toast = useToast();
  const ui = useUI();
  const projects = useProjects();

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [bundleVersion, setBundleVersion] = useState<number | null>(null);
  const [formalReady, setFormalReady] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState("");
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
  const [snapshotText, setSnapshotText] = useState<string | null>(null);
  const snapCache = useRef(new Map<string, string>());
  const autoLoaded = useRef(false);
  const lastUpdatedAt = useRef<string | null>(null);

  // 切换项目:清空上一个项目的全部状态
  useEffect(() => {
    setDetail(null);
    setBundle(null);
    setBundleVersion(null);
    setFormalReady({});
    setSelectedClaim(null);
    setSnapshotText(null);
    setLoadFailed(false);
    setBusy("");
    autoLoaded.current = false;
    lastUpdatedAt.current = null;
    snapCache.current = new Map();
  }, [id]);

  const reload = useCallback(async () => {
    try {
      const d = await api<ProjectDetail>(`/api/projects/${id}`);
      setDetail(d);
      setLoadFailed(false);
      // 首次拿到详情后默认选中最新版本
      if (!autoLoaded.current) {
        autoLoaded.current = true;
        const latest = d.meta.versions[d.meta.versions.length - 1];
        if (latest) {
          setBundleVersion(latest.version);
          try {
            setBundle(await api<Bundle>(`/api/projects/${id}/versions/${latest.version}/bundle`));
          } catch { /* 版本探测失败不阻断页面 */ }
        }
      }
      // meta 变化时同步侧栏项目列表(版本数/更新时间)
      if (lastUpdatedAt.current !== null && lastUpdatedAt.current !== d.meta.updatedAt) {
        void projects.reload();
      }
      lastUpdatedAt.current = d.meta.updatedAt;
    } catch {
      setLoadFailed(true);
    }
  }, [id, projects]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 2500);
    return () => window.clearInterval(timer);
  }, [reload]);

  // 探测各版本正式报告是否已生成(版本集合变化时补测)
  const versionsKey = detail ? detail.meta.versions.map((v) => v.version).join(",") : "";
  useEffect(() => {
    if (!versionsKey) return;
    let cancelled = false;
    void (async () => {
      const ready: Record<number, boolean> = {};
      await Promise.all(
        versionsKey.split(",").map(async (raw) => {
          const v = Number(raw);
          const res = await fetch(`/api/projects/${id}/versions/${v}/formal/json`).catch(() => null);
          if (res?.ok) ready[v] = true;
        }),
      );
      if (!cancelled) setFormalReady((prev) => ({ ...prev, ...ready }));
    })();
    return () => { cancelled = true; };
  }, [id, versionsKey]);

  const selectVersion = useCallback(async (v: number) => {
    setBundleVersion(v);
    setSelectedClaim(null);
    setSnapshotText(null);
    try {
      setBundle(await api<Bundle>(`/api/projects/${id}/versions/${v}/bundle`));
    } catch (e) {
      setBundle(null);
      toast.show(errMsg(e));
    }
  }, [id, toast]);

  const genFormal = useCallback(async (v: number) => {
    setBusy(`生成正式报告中…(v${v})`);
    try {
      const r = await post<{ summarySource: string }>(`/api/projects/${id}/versions/${v}/formal`, {});
      setFormalReady((prev) => ({ ...prev, [v]: true }));
      toast.show(r.summarySource === "model" ? "正式报告已生成(含摘要提炼)" : "正式报告已生成(摘要为确定性兜底)");
    } catch (e) {
      toast.show(errMsg(e));
    } finally {
      setBusy("");
    }
  }, [id, toast]);

  const startRun = useCallback(
    async (p: StartRunParams): Promise<{ ok: boolean; rejected: Array<{ sourceId: string; reason: string }> }> => {
      try {
        const started = await post<{
          reuse?: { bound: number; rejected: Array<{ sourceId: string; reason: string }> };
        }>(`/api/projects/${id}/runs`, {
          request: {
            id: `req-${Date.now().toString(36)}`,
            module: detail?.meta.module ?? "brand",
            goal: p.goal,
            scope: { summary: p.summary, queries: p.plan.map((q) => q.question) },
            attachments: p.attachments.split("\n").map((s) => s.trim()).filter(Boolean),
            outline: p.outline,
            // 交互运行用适中预算:约 10 分钟内出结果;更深的重跑走 CLI 自定义预算
            budget: { maxSearches: 8, maxFetches: 12 },
          },
          plan: { questions: p.plan.map((q) => ({ ...q, status: "open" })) },
          // 2.0:复用选择在请求体顶层,服务端绑定后随 run 固定版本
          selectedAssets: p.selectedAssets,
        });
        const rejected = started.reuse?.rejected ?? [];
        toast.show(
          rejected.length > 0
            ? `研究运行已启动;${rejected.length} 项选择因权限/状态被拒绝(未绑定)`
            : "研究运行已启动,可在「采证」阶段跟踪进度",
        );
        await reload();
        void projects.reload();
        return { ok: true, rejected };
      } catch (e) {
        toast.show(errMsg(e));
        return { ok: false, rejected: [] };
      }
    },
    [detail?.meta.module, id, projects, reload, toast],
  );

  const cancelRun = useCallback(async (r: Run) => {
    try {
      await post(`/api/projects/${id}/runs/cancel`, { requestId: r.requestId });
      toast.show("已取消,已完成阶段保留");
      await reload();
    } catch (e) {
      toast.show(errMsg(e));
    }
  }, [id, reload, toast]);

  const resumeRun = useCallback(async (r: Run) => {
    try {
      await post(`/api/projects/${id}/runs/resume`, { requestId: r.requestId });
      toast.show("已自检查点恢复运行");
      await reload();
    } catch (e) {
      toast.show(errMsg(e));
    }
  }, [id, reload, toast]);

  const publishRun = useCallback(async (r: Run) => {
    try {
      await post(`/api/projects/${id}/publish`, { runId: r.id });
      toast.show("已发布为新版本");
      autoLoaded.current = true; // 手动选版本逻辑接管,避免轮询覆盖
      await reload();
      void projects.reload();
    } catch (e) {
      toast.show(errMsg(e));
    }
  }, [id, projects, reload, toast]);

  const openClaim = useCallback((c: Claim | null) => {
    setSelectedClaim(c);
    setSnapshotText(null);
    if (c) {
      ui.setInspTab("evidence");
      const ev = bundle?.evidence.find((e) => e.id === c.evidenceIds[0]);
      if (ev) {
        const cached = snapCache.current.get(ev.snapshotId);
        if (cached !== undefined) {
          setSnapshotText(cached);
        } else {
          void fetch(`/api/projects/${id}/snapshots?sid=${encodeURIComponent(ev.snapshotId)}`)
            .then(async (res) => {
              const text = res.ok ? await res.text() : "(快照不可用)";
              snapCache.current.set(ev.snapshotId, text);
              return text;
            })
            .catch(() => "(快照不可用)")
            .then((text) => {
              // 仅当选中主张未变时回填,避免快速切换时串台
              setSelectedClaim((cur) => {
                if (cur?.id === c.id) setSnapshotText(text);
                return cur;
              });
            });
        }
      }
    }
  }, [bundle, id, ui]);

  const activeRun = detail?.runs.find((r) => r.status === "running") ?? null;
  const progress = detail
    ? activeRun
      ? stageIndexOf(activeRun.stage)
      : detail.meta.versions.length > 0
        ? STAGES.length
        : 0
    : 0;

  return (
    <Ctx.Provider
      value={{
        id, detail, loadFailed, activeRun, progress,
        bundle, bundleVersion, selectVersion,
        formalReady, genFormal, busy,
        startRun, cancelRun, resumeRun, publishRun,
        selectedClaim, snapshotText, openClaim,
        reload,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useProjectOrNull = (): ProjectCtx | null => useContext(Ctx);

export const useProject = (): ProjectCtx => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProject 必须在 ProjectDetailProvider 内使用");
  return ctx;
};
