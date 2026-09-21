import type { ModuleConfig } from "./types.js";

export const industryConfig: ModuleConfig = {
  schemaVersion: "1.0",
  module: "industry",
  questionFramework: [
    { id: "boundary", title: "行业边界", keywords: ["边界", "定义"] },
    { id: "scale", title: "规模口径", keywords: ["规模", "口径"] },
    { id: "chain", title: "产业链", keywords: ["产业链", "链条"] },
    { id: "competition", title: "竞争", keywords: ["竞争", "格局"] },
  ],
  sourceStrategy: { validationRules: ["numeric-claims-calibrated", "fact-claims-evidenced"] },
  reportTemplate: {
    title: "行业研究报告",
    sections: [
      { id: "caliber", title: "市场口径表", required: true },
      { id: "structure", title: "行业结构", required: true },
      { id: "trend", title: "趋势与风险", required: true },
    ],
  },
};
