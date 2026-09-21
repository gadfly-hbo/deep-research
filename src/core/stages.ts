import { z } from "zod";

export const StageNameSchema = z.enum(["plan", "analyze", "draft", "review"]);
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
