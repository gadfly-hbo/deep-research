import { z } from "zod";
import { ReportOutlineSchema } from "../contracts.js";

export const StageNameSchema = z.enum(["plan", "outline", "analyze", "draft", "polish", "review", "formal"]);
export type StageName = z.infer<typeof StageNameSchema>;

export const PlanQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  method: z.string().optional(),
  status: z.enum(["open", "answered", "partially", "unanswered", "skipped"]).default("open"),
});
export type PlanQuestion = z.infer<typeof PlanQuestionSchema>;

export const PlanOutputSchema = z.object({
  questions: z.array(PlanQuestionSchema).min(1),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

export const OutlineOutputSchema = ReportOutlineSchema;
export type OutlineOutput = z.infer<typeof OutlineOutputSchema>;

/** 正式报告化:只允许重组草稿既有内容,不得新增事实。 */
export const FormalOutputSchema = z.object({
  executiveSummary: z.array(z.string().min(1)).min(1),
  sectionHighlights: z
    .array(z.object({ sectionId: z.string().min(1), bullets: z.array(z.string().min(1)).min(1) }))
    .default([]),
});
export type FormalOutput = z.infer<typeof FormalOutputSchema>;

export const AnalyzeOutputSchema = z.object({
  findings: z
    .array(
      z.object({
        questionId: z.string(),
        summary: z.string(),
        claimIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  gaps: z.array(z.object({ questionId: z.string(), reason: z.string() })).default([]),
});
export type AnalyzeOutput = z.infer<typeof AnalyzeOutputSchema>;

export const DraftOutputSchema = z.object({
  reportMd: z.string().min(1),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

/** 润色/扩写:只丰富表达与结构,严禁新增无证据支撑的事实与数字。 */
export const PolishOutputSchema = z.object({
  reportMd: z.string().min(1),
});
export type PolishOutput = z.infer<typeof PolishOutputSchema>;

/**
 * 模型偶发把报告双重编码:schema 校验只能保证 reportMd 是字符串,挡不住
 * "值本身是 {"report": "..."} 这类 JSON 文本"。此函数在 schema parse 前尽力还原:
 * 对象取 reportMd/report 别名字段;字段值若是 JSON 文本则递归解包(≤3 层),否则原样透传。
 */
export function coerceDraftOutput(raw: unknown, depth = 0): unknown {
  if (depth > 2 || raw === null || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const field = typeof o.reportMd === "string" ? o.reportMd : typeof o.report === "string" ? o.report : undefined;
  if (field === undefined) return raw;
  return { reportMd: unwrapJsonText(field, depth) };
}

function unwrapJsonText(text: string, depth: number): string {
  const t = text.trim();
  if (depth > 2 || (!t.startsWith("{") && !t.startsWith('"'))) return text;
  try {
    const parsed = JSON.parse(t) as unknown;
    if (typeof parsed === "string") return unwrapJsonText(parsed, depth + 1);
    if (parsed !== null && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      if (typeof o.reportMd === "string") return unwrapJsonText(o.reportMd, depth + 1);
      if (typeof o.report === "string") return unwrapJsonText(o.report, depth + 1);
    }
  } catch {
    /* 不是合法 JSON,按原样返回 */
  }
  return text;
}

export const ReviewIssueSchema = z.object({
  severity: z.enum(["high", "low"]),
  kind: z.enum(["citation", "caliber", "gap", "counterexample", "other"]),
  detail: z.string().min(1),
  targetClaimId: z.string().optional(),
  targetQuestionId: z.string().optional(),
  fix: z.enum(["regather", "rephrase", "disclose"]),
});
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const ReviewOutputSchema = z.object({
  issues: z.array(ReviewIssueSchema).default([]),
  counterexampleChecked: z.boolean(),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
