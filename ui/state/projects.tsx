/* 项目列表上下文:侧栏三级树、项目总览、命令面板共用一份数据。
   U1(D1/G1-3):列表附带 runs 轻量摘要;档位轮询——常驻 30s,任一项目存在 running/awaiting
   时提至 2.5s,409 兜底后 boostAndReload(立即刷新+临时提频);轮询静默不抢焦点。 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, errMsg, post } from "./api";
import type { Module, ProjectWithRuns } from "./types";
import { useToast } from "./toast";

const SLOW_MS = 30_000;
const FAST_MS = 2_500;
const BOOST_MS = 10_000;

interface ProjectsCtx {
  projects: ProjectWithRuns[];
  loaded: boolean;
  error: string | null;
  reload(): Promise<void>;
  /** U1(G1-3):409 竞态兜底——立即刷新并临时提频。 */
  boostAndReload(): Promise<void>;
  create(form: { module: Module; goal: string; summary: string; name?: string }): Promise<string | null>;
  toggleArchive(p: ProjectWithRuns): Promise<void>;
}

const Ctx = createContext<ProjectsCtx | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectWithRuns[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fastUntilRef = useRef(0);

  const reload = useCallback(async () => {
    try {
      const r = await api<{ projects: ProjectWithRuns[] }>("/api/projects");
      setProjects(r.projects);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  const boostAndReload = useCallback(async () => {
    fastUntilRef.current = Date.now() + BOOST_MS;
    await reload();
  }, [reload]);

  useEffect(() => { void reload(); }, [reload]);

  // U1(G1-3):档位轮询——判据自举(上次响应的 runs 摘要)+ 409 临时提频;档位变更重建 interval
  const hasActive = projects.some((p) => p.runs.some((r) => r.status === "running" || r.status === "awaiting-confirmation"));
  useEffect(() => {
    const period = hasActive || Date.now() < fastUntilRef.current ? FAST_MS : SLOW_MS;
    const t = window.setInterval(() => { void reload(); }, period);
    return () => window.clearInterval(t);
  }, [hasActive, reload]);

  const create = useCallback(async (form: { module: Module; goal: string; summary: string; name?: string }): Promise<string | null> => {
    try {
      const r = await post<{ id: string }>("/api/projects", {
        module: form.module,
        goal: form.goal,
        scope: { summary: form.summary, queries: [] },
        ...(form.name && form.name.trim() ? { name: form.name.trim() } : {}),
      });
      toast.show("项目已创建");
      await reload();
      return r.id;
    } catch (e) {
      toast.show(errMsg(e));
      return null;
    }
  }, [reload, toast]);

  const toggleArchive = useCallback(async (p: ProjectWithRuns): Promise<void> => {
    try {
      await post(`/api/projects/${p.id}/archive`, { archived: p.status !== "archived" });
      toast.show(p.status === "archived" ? "已恢复到进行中" : "已归档,数据与版本全部保留");
      await reload();
    } catch (e) {
      toast.show(errMsg(e));
    }
  }, [reload, toast]);

  return (
    <Ctx.Provider value={{ projects, loaded, error, reload, boostAndReload, create, toggleArchive }}>
      {children}
    </Ctx.Provider>
  );
}

export const useProjects = (): ProjectsCtx => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProjects 必须在 ProjectsProvider 内使用");
  return ctx;
};
