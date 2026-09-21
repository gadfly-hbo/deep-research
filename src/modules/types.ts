export interface ModuleTopic {
  id: string;
  title: string;
  keywords: string[];
}

export interface ModuleReportSection {
  id: string;
  title: string;
  required: boolean;
}

export type ModuleQualityRule = "numeric-claims-calibrated" | "fact-claims-evidenced";

export interface ModuleConfig {
  schemaVersion: string;
  module: "brand" | "industry";
  /** 研究方法与问题框架(覆盖主题清单,plan 阶段据此拆问题) */
  questionFramework: ModuleTopic[];
  /** 来源策略与验证规则 */
  sourceStrategy: { preferredDomains?: string[]; validationRules: ModuleQualityRule[] };
  /** 报告模板与结构化字段 */
  reportTemplate: { title: string; sections: ModuleReportSection[] };
}
