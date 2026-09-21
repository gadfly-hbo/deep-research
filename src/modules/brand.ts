import type { ModuleConfig } from "./types.js";

export const brandConfig: ModuleConfig = {
  schemaVersion: "1.0",
  module: "brand",
  questionFramework: [
    { id: "positioning", title: "品牌定位", keywords: ["定位"] },
    { id: "pricing", title: "产品价格", keywords: ["价格", "定价", "客单价"] },
    { id: "channels", title: "渠道", keywords: ["渠道"] },
    { id: "competitors", title: "竞品", keywords: ["竞品", "竞争"] },
  ],
  sourceStrategy: { validationRules: ["numeric-claims-calibrated", "fact-claims-evidenced"] },
  reportTemplate: {
    title: "品牌研究报告",
    sections: [
      { id: "profile", title: "品牌档案", required: true },
      { id: "compare", title: "竞品对比表", required: true },
      { id: "oro", title: "机会-风险-假设", required: true },
    ],
  },
};
