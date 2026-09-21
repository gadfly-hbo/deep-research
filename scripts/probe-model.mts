import { piAiModel } from "../src/adapters/live.js";
const model = piAiModel([
  { provider: "minimax-cn", modelId: "MiniMax-M2.7" },
  { provider: "xiaomi-token-plan-cn", modelId: "mimo-v2.5-pro", api: "openai-completions", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" },
]);
const snapshot = { id: "s1", url: "https://example.com", title: "t", fetchedAt: "2026-09-21T00:00:00Z", bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年)。", parseStatus: "ok" as const, contentType: "text/html" };
const r = await model.extractClaims({ snapshot }, "probe:0");
console.log("claims:", JSON.stringify(r.claims, null, 1).slice(0, 300));
const s = await model.runStage("plan", { goal: "中国咖啡行业研究", scope: { summary: "中国大陆 2025", queries: [] }, questionFramework: [{id:"scale",title:"规模口径",keywords:["规模"]}] }, "probe:1");
console.log("plan output:", JSON.stringify(s.output).slice(0, 200));
