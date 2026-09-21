import { z } from "zod";

export const CalibrationSchema = z.object({
  entity: z.string().min(1),
  period: z.string().min(1),
  unit: z.string().min(1),
  value: z.number().optional(),
});
export type Calibration = z.infer<typeof CalibrationSchema>;

export const SourceSnapshotSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  title: z.string(),
  fetchedAt: z.string().min(1),
  bodyText: z.string(),
  parseStatus: z.enum(["ok", "failed"]),
  contentType: z.string(),
});
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  snapshotId: z.string().min(1),
  quote: z.string(),
  locator: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ClaimSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  kind: z.enum(["fact", "inference", "unverified"]),
  evidenceIds: z.array(z.string().min(1)),
  calibration: CalibrationSchema.optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const CitationVerdictSchema = z.object({
  evidenceId: z.string().min(1),
  verdict: z.enum(["quote-hit", "quote-mismatch", "snapshot-missing"]),
  urlAlive: z.boolean().optional(),
});
export type CitationVerdict = z.infer<typeof CitationVerdictSchema>;

export const BudgetSchema = z.object({
  maxSearches: z.number().int().positive(),
  maxFetches: z.number().int().positive(),
  maxCostEstimate: z.number().positive(),
  maxWallMs: z.number().positive(),
  maxParallel: z.number().int().positive(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const ResearchRequestSchema = z.object({
  id: z.string().min(1).optional(),
  module: z.enum(["brand", "industry"]),
  goal: z.string().min(1),
  scope: z.object({
    summary: z.string().min(1),
    queries: z.array(z.string().min(1)),
  }),
  attachments: z.array(z.string()).default([]),
  budget: BudgetSchema.partial().optional(),
  configVersion: z.string().optional(),
});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

export const ResearchRunSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1),
  stage: z.enum(["plan", "gather", "analyze", "draft", "review", "publish"]),
  status: z.enum(["running", "cancelled", "failed", "published", "limited"]),
  checkpoints: z.array(z.string()),
  usage: z.object({
    searches: z.number().int().nonnegative(),
    fetches: z.number().int().nonnegative(),
    costEstimate: z.number().nonnegative(),
    wallMs: z.number().nonnegative(),
  }),
  error: z.string().optional(),
});
export type ResearchRun = z.infer<typeof ResearchRunSchema>;

export const ResearchResultBundleSchema = z.object({
  runId: z.string().min(1),
  version: z.number().int().nonnegative(),
  reportMd: z.string().min(1),
  reportHtml: z.string().optional(),
  claims: z.array(ClaimSchema),
  evidence: z.array(EvidenceSchema),
  snapshots: z.array(SourceSnapshotSchema),
  limitations: z.array(z.string()),
  unresolved: z.array(z.string()),
  verdicts: z.array(CitationVerdictSchema),
  auditSummary: z.string().optional(),
});
export type ResearchResultBundle = z.infer<typeof ResearchResultBundleSchema>;
