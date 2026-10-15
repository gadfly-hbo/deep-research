/* 阶段 1 向导的请求编排(P1-4 自 PlanView 下沉):计划/框架预览的调用、busy 时序与产物状态。
   表单/复用选择/基准 run 选择留在视图(R1-1/R1-4);请求入参拼装与下沉前逐字一致。
   module 在详情就绪前为 undefined——钩子必须无条件调用,动作入口统一守卫(无详情时按钮不渲染,守卫不可达)。 */
import { useCallback, useState } from "react";
import { errMsg, post } from "./api";
import { useToast } from "./toast";
import type { BudgetTier, Module, Outline } from "./types";

export interface PlanQuestion { id: string; question: string }
export interface WizardForm { goal: string; summary: string; attachments: string; budgetTier: BudgetTier }
export interface BaseRunRef { runId: string; requestId: string }
export interface BaseSummary {
  runId: string; answeredQuestions: number; evidence: number; snapshots: number; claims: number;
}

export function usePlanWizard(projectId: string, module: Module | undefined) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const [plan, setPlan] = useState<PlanQuestion[] | null>(null);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [baseSummary, setBaseSummary] = useState<BaseSummary | null>(null);

  const previewPlan = useCallback(async (form: WizardForm, baseRun: BaseRunRef | null) => {
    if (!module) return;
    setBusy("生成计划中…通常 1-2 分钟");
    try {
      const r = await post<{
        plan: { questions: PlanQuestion[] };
        base?: BaseSummary;
      }>(`/api/projects/${projectId}/plan-preview`, {
        module,
        goal: form.goal,
        scope: { summary: form.summary, queries: [] },
        ...(baseRun ? { incrementalOf: baseRun } : {}),
      });
      setPlan(r.plan.questions);
      setBaseSummary(r.base ?? null);
      setOutline(null);
    } catch (e) {
      toast.show(errMsg(e));
    } finally {
      setBusy("");
    }
  }, [projectId, module, toast]);

  const previewOutline = useCallback(async (form: WizardForm, plan: PlanQuestion[], baseRun: BaseRunRef | null) => {
    if (!module || !plan) return;
    setBusy("生成报告框架中…通常 1-2 分钟");
    try {
      const r = await post<{ outline: Outline }>(`/api/projects/${projectId}/outline-preview`, {
        module,
        goal: form.goal,
        scope: { summary: form.summary, queries: plan.map((q) => q.question) },
        questions: plan.map((q) => ({ id: q.id, question: q.question })),
        ...(baseRun ? { incrementalOf: baseRun } : {}),
      });
      setOutline(r.outline);
    } catch (e) {
      toast.show(errMsg(e));
    } finally {
      setBusy("");
    }
  }, [projectId, module, toast]);

  return { busy, setBusy, plan, setPlan, outline, setOutline, baseSummary, setBaseSummary, previewPlan, previewOutline };
}
