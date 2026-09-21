import { z } from "zod";
import { ReportOutlineSchema } from "../contracts.js";

export const StageNameSchema = z.enum(["plan", "outline", "analyze", "draft", "review", "formal"]);
export type StageName = z.infer<typeof StageNameSchema>;

export const PlanQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  method: z.string().optional(),
  status: z.enum(["open", "answered", "partially", "unanswered"]).default("open"),
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
