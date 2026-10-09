// 诊断:mimo-v2.6-flash 不在 pi-ai 内置清单,按 §7.2 自定义 Model(baseUrl+api)接法实测
import { piAiModel } from "../src/adapters/live.js";
const model = piAiModel([
  {
    provider: "xiaomi-token-plan-cn",
    modelId: "mimo-v2.6-flash",
    api: "openai-completions",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
  },
]);
const snapshot = {
  id: "s1",
  url: "https://example.com",
  title: "t",
  fetchedAt: "2026-10-06T00:00:00Z",
  bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年)。",
  parseStatus: "ok" as const,
  contentType: "text/html",
};
const t0 = Date.now();
const r = await model.extractClaims({ snapshot }, `probe:${Date.now()}`);
console.log(`mimo-v2.6-flash 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s, claims:`, JSON.stringify(r.claims).slice(0, 300));
