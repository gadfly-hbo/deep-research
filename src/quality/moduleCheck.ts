import type { Claim } from "../contracts.js";
import type { PlanQuestion } from "../core/stages.js";
import type { ModuleConfig } from "../modules/types.js";

export interface ModuleCheckInput {
  reportMd: string;
  claims: Claim[];
  questions: PlanQuestion[];
}

export interface ModuleCheckResult {
  passed: boolean;
  missingSections: string[];
  uncoveredTopics: string[];
  violations: string[];
}

export function checkModuleOutput(cfg: ModuleConfig, input: ModuleCheckInput): ModuleCheckResult {
  const required = cfg.reportTemplate.sections.filter((s) => s.required);
  const missingSections = required
    .filter((s) => !input.reportMd.includes(s.title))
    .map((s) => s.title);

  const uncoveredTopics = cfg.questionFramework
    .filter((topic) => {
      const byClaim = input.claims.some((c) =>
        topic.keywords.some((k) => c.statement.includes(k)),
      );
      const byQuestion = input.questions.some(
        (q) => q.status === "answered" && topic.keywords.some((k) => q.question.includes(k)),
      );
      return !byClaim && !byQuestion;
    })
    .map((t) => t.title);

  const violations: string[] = [];
  for (const rule of cfg.sourceStrategy.validationRules) {
    if (rule === "numeric-claims-calibrated") {
      for (const c of input.claims) {
        if (/\d/.test(c.statement) && !c.calibration) {
          violations.push(`numeric-claims-calibrated: 数值主张缺口径(对象/时间/单位) "${c.statement}"(${c.id})`);
        }
      }
    } else if (rule === "fact-claims-evidenced") {
      for (const c of input.claims) {
        if (c.kind === "fact" && c.evidenceIds.length === 0) {
          violations.push(`fact-claims-evidenced: 事实主张无证据 "${c.statement}"(${c.id})`);
        }
      }
    }
  }

  return {
    passed: missingSections.length === 0 && uncoveredTopics.length === 0 && violations.length === 0,
    missingSections,
    uncoveredTopics,
    violations,
  };
}
